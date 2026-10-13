/**
 * Kafka producer ACL generator (C01 §2.5 "Per-topic producer ACL", M8, R47-06, R47-25; plan S-PLAT-I1 item 11).
 *
 * Every topic's ACL names exactly its producing principals and nothing else. Kafka enforces WRITE per topic.
 * The generator works from the owner declarations and from the producer lists that other contracts name
 * (for example C06's `settlement.posting-acks.v1`).
 */
import type { OwnerDeclaration } from '../api.ts';
import { cdcTopic, closureTopic, relayProgressTopic } from '../feed/wire.ts';

export interface TopicAcl {
  topic: string;
  /** Producing principals, sorted. */
  producers: string[];
  /** Where the rule comes from (C01 §2.5 row, or the contract that names the producers). */
  source: string;
}

export interface ExtraProducers {
  topic: string;
  producers: string[];
  contractRef: string;
}

export interface AclOptions {
  /** The database's CDC principal (writes `cdc.<kind>` and `cdc.audit.<kind>`). */
  cdcPrincipal?: string;
  /** Producer lists named by other contracts. */
  extra?: ExtraProducers[];
}

export const holderPrincipal = (kind: string): string => `${kind}-holder`;
export const relayPrincipal = (kind: string): string => `${kind}-relay`;
export const closureEmitterPrincipal = (kind: string): string => `closure-emitter-${kind}`;

/** The ACL of every topic of these declarations (one entry per topic). */
export function producerAcls(decls: OwnerDeclaration[], o: AclOptions = {}): TopicAcl[] {
  const cdc = o.cdcPrincipal ?? 'cockroach-cdc';
  const acl = new Map<string, TopicAcl>();
  const put = (topic: string, producers: string[], source: string): void => {
    const cur = acl.get(topic);
    if (cur && cur.producers.join(',') !== [...new Set(producers)].sort().join(',')) {
      throw new Error(`topic ${topic}: two producer lists (${cur.source}; ${source})`);
    }
    acl.set(topic, { topic, producers: [...new Set(producers)].sort(), source });
  };
  for (const d of decls) {
    const k = d.kind;
    for (const s of d.streams) {
      put(s.topic, [holderPrincipal(k), relayPrincipal(k)], 'C01 §2.5 <kind>.<feed>.v<n>');
      if (s.closure !== 'none') put(closureTopic(s.topic), [closureEmitterPrincipal(k)], 'C01 §2.5 <topic>.closure');
    }
    for (const m of d.messages ?? []) put(m.topic, [holderPrincipal(k), relayPrincipal(k)], 'declared non-log message (stream ACL)');
    // Point-to-point notifications (erratum: `<kind>.notifications.v1`) are an owner feed of the sender kind.
    put(`${k}.notifications.v1`, [holderPrincipal(k), relayPrincipal(k)], 'C01 §2.5 (notifications, v1.1 erratum)');
    put(`${k}.alert.v1`, [holderPrincipal(k), relayPrincipal(k)], 'C01 §2.5 <kind>.alert.v1');
    put(cdcTopic(k), [cdc], 'C01 §2.5 cdc.<kind>');
    put(`cdc.audit.${k}`, [cdc], 'C01 §2.5 cdc.audit.<kind>');
    put(relayProgressTopic(k), [relayPrincipal(k)], 'C01 §2.5 relay.progress.<kind>');
  }
  put('placement.slot_map.v1', [holderPrincipal('placement'), relayPrincipal('placement')], 'C01 §2.5 placement topics');
  put('placement.routing.v1', [holderPrincipal('placement'), relayPrincipal('placement')], 'C01 §2.5 placement topics');
  for (const e of o.extra ?? []) put(e.topic, e.producers, e.contractRef);
  return [...acl.values()].sort((a, b) => a.topic.localeCompare(b.topic));
}

/** `kafka-acls.sh` lines that create the ACLs (literal topic names, WRITE only). */
export function aclCommands(acls: TopicAcl[], bootstrap = 'localhost:9092'): string[] {
  return acls.flatMap((a) => a.producers.map((p) =>
    `kafka-acls.sh --bootstrap-server ${bootstrap} --add --allow-principal User:${p} --operation Write --resource-pattern-type literal --topic ${a.topic}`));
}

/** The same ACLs in kafkajs `admin.createAcls` form (resourceType TOPIC = 2, operation WRITE = 4, ALLOW = 3, LITERAL = 3). */
export function kafkajsAcls(acls: TopicAcl[]): Array<{
  resourceType: number; resourceName: string; resourcePatternType: number; principal: string; host: string; operation: number; permissionType: number;
}> {
  return acls.flatMap((a) => a.producers.map((p) => ({
    resourceType: 2, resourceName: a.topic, resourcePatternType: 3, principal: `User:${p}`, host: '*', operation: 4, permissionType: 3,
  })));
}

/** Compare actual WRITE ACLs (topic → principals) with the generated ones; every difference is a finding. */
export function checkAcls(expected: TopicAcl[], actual: Map<string, string[]>): string[] {
  const out: string[] = [];
  for (const a of expected) {
    const got = [...new Set(actual.get(a.topic) ?? [])].sort();
    for (const p of got) if (!a.producers.includes(p)) out.push(`${a.topic}: ${p} may WRITE but is not a producer (${a.source})`);
    for (const p of a.producers) if (!got.includes(p)) out.push(`${a.topic}: producer ${p} has no WRITE ACL`);
  }
  for (const [t, ps] of actual) if (!expected.some((a) => a.topic === t) && ps.length > 0) out.push(`${t}: WRITE ACLs on a topic no declaration names`);
  return out;
}
