/**
 * The I1 walking-skeleton harness: identity, a test owner and audit on C01 runtime doubles, the edge gateway,
 * the dev key service, all on one simulated clock.
 *
 * S-PLAT I1a has no relay and no closure emitter yet (STATUS-I1a.md, TODO(I1b)). `relay()` stands in for
 * them: it moves identity's committed push events to the consumer and sends a resolved marker to every
 * push partition once per tick (C01 §3.5, §3.6). It is test code, not a component.
 */
import { hlcFromWallMs } from '@share/owner-runtime';
import { RuntimeDouble, feedEvent } from '@share/owner-runtime/testing';
import { CertStore, type PolicyBundle } from '@share/iam-lib';
import { DevKeyService } from '@share/key-service';
import { IdentityOwner, STATUS_TOPIC, declaration as iamDeclaration, identitySlotOf } from '@share/identity-owner';
import { FIXTURE_WORKLOAD, KeyFixture } from '@share/identity-owner/testing';
import { EdgeGateway, EdgeReplica, type EdgeClock } from '@share/edge-auth';
import { AuditService, declaration as auditDeclaration } from '@share/audit';
import { TestOwner, declaration as testDeclaration } from '@share/sec-test-owner';

export const EDGE_WORKLOAD = 'spiffe://share/edge/node-1';
export const TEST_OWNER_WORKLOAD = 'spiffe://share/sectest/holder';
export const PUSH_PARTITIONS = 4;
export const START_MS = 1_700_000_000_000;
const noSleep = async (): Promise<void> => {};

export interface Skeleton {
  nowMs(): number;
  advance(ms: number): void;
  /** One second (or `ms`) of the world: cert stream, edge stream, relay. */
  tick(ms?: number): Promise<void>;
  cut: { edgeStream: boolean; relay: boolean; certStream: boolean };
  keys: DevKeyService;
  iamRt: RuntimeDouble; ownerRt: RuntimeDouble; auditRt: RuntimeDouble;
  identity: IdentityOwner; fixture: KeyFixture; owner: TestOwner; audit: AuditService;
  replica: EdgeReplica; edgeCerts: CertStore; ownerCerts: CertStore; gateway: EdgeGateway;
  policy: PolicyBundle;
  pages: string[];
  forwarded: number;
  /** Identity slots the edge streams (the slots of the accounts in use). */
  watch(account: string): void;
  issue(account: string): Promise<{ key_id: string; token: string }>;
  revoke(account: string, keyId: string): Promise<void>;
  relayDeliveries: number;
}

export async function skeleton(): Promise<Skeleton> {
  let ms = START_MS;
  const nowMicros = (): bigint => BigInt(ms) * 1000n;
  const keys = new DevKeyService(nowMicros);
  const iamRt = new RuntimeDouble({ declaration: iamDeclaration, startMs: START_MS });
  const ownerRt = new RuntimeDouble({ declaration: testDeclaration, startMs: START_MS });
  const auditRt = new RuntimeDouble({ declaration: auditDeclaration, startMs: START_MS });
  const pages: string[] = [];

  const identity = new IdentityOwner({ runtime: iamRt, certifier: keys, sleep: noSleep, alert: () => {} });
  iamRt.attach(identity);
  const fixture = new KeyFixture(identity);
  const audit = new AuditService({ runtime: auditRt, allowlist: new Set([EDGE_WORKLOAD, TEST_OWNER_WORKLOAD]),
    page: (m) => pages.push(m), sleep: noSleep });
  auditRt.attach(audit);

  const got = identity.getPolicy();
  if ('kind' in got) throw new Error('no policy');
  const policy = got;

  const ownerCerts = new CertStore(keys.rootPublicKey);
  const edgeCerts = new CertStore(keys.rootPublicKey);
  const owner = new TestOwner({ runtime: ownerRt, certs: ownerCerts, edgeAllowlist: new Set([EDGE_WORKLOAD]),
    identitySlotOf, policy, audit: { client: audit, workload: TEST_OWNER_WORKLOAD }, sleep: noSleep });
  ownerRt.attach(owner);
  owner.start();

  const advance = (d: number): void => {
    ms += d;
    iamRt.advance(d); ownerRt.advance(d); auditRt.advance(d);
  };
  const clock: EdgeClock = {
    nowMicros,
    waitUntil: async (t) => {
      const now = nowMicros();
      if (t > now) advance(Number((t - now + 999n) / 1000n));
    },
  };

  const replica = new EdgeReplica(edgeCerts);
  const s: Skeleton = {
    nowMs: () => ms,
    advance,
    cut: { edgeStream: false, relay: false, certStream: false },
    keys, iamRt, ownerRt, auditRt, identity, fixture, owner, audit, replica, edgeCerts, ownerCerts, policy, pages,
    forwarded: 0,
    relayDeliveries: 0,
    gateway: undefined as unknown as EdgeGateway,
    watch: (account) => { watched.add(identitySlotOf({ kind: 'account', account })); },
    tick: async (d = 1000) => {
      advance(d);
      if (!s.cut.certStream) {
        for (const c of [edgeCerts, ownerCerts]) for (const m of keys.read(c.head)) c.apply(m);
      }
      if (!s.cut.edgeStream) {
        for (const slot of watched) replica.apply(slot, identity.edgeStream(slot, replica.position(slot)), nowMicros());
      }
      if (!s.cut.relay) await relay();
    },
    issue: async (account) => {
      const a = await fixture.issueAgentKey(FIXTURE_WORKLOAD, account);
      if (!a.ok || !('token' in a)) throw new Error(`fixture issue failed: ${JSON.stringify(a)}`);
      return { key_id: a.key_id, token: a.token };
    },
    revoke: async (account, keyId) => {
      const a = await fixture.revokeAgentKey(FIXTURE_WORKLOAD, account, keyId);
      if (!a.ok) throw new Error(`fixture revoke failed: ${JSON.stringify(a)}`);
    },
  };
  const watched = new Set<number>();
  let relayed = 0;
  const relay = async (): Promise<void> => {
    const pub = iamRt.published;
    for (; relayed < pub.length; relayed++) {
      const p = pub[relayed];
      if (!p || p.topic !== STATUS_TOPIC) continue;
      await ownerRt.deliver(STATUS_TOPIC, feedEvent({ partition: p.partition, stream: p.stream, streamSeq: p.streamSeq, event: p.event }));
      s.relayDeliveries++;
    }
    for (let k = 0; k < PUSH_PARTITIONS; k++) ownerRt.resolve(STATUS_TOPIC, k, hlcFromWallMs(ms));
  };
  s.gateway = new EdgeGateway({
    replica, policy, router: ownerRt, clock, workload: EDGE_WORKLOAD,
    forwarder: {
      forward: async (to, md, peer, cmd) => {
        s.forwarded++;
        if (to.slot !== owner.slotOf(cmd.account)) throw new Error('forwarded to the wrong slot');
        return owner.command(peer, md, cmd);
      },
    },
  });
  // Bring the cert stream and every watched slot to fresh.
  await s.tick(0);
  return s;
}

export function bearer(token: string): string {
  return `Bearer ${token}`;
}
