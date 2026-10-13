/**
 * The I1 walking-skeleton world: the five S-RATE owner kinds, each on its own runtime double,
 * joined by the test bus, with the provisioning producer, the account owner double and the
 * settlement and ledger double.
 */
import { RuntimeDouble } from '@share/owner-runtime/testing';
import {
  IngestOwner, emitHandoff, ingestDeclaration, type BatchEntryPayload, type IngestSession,
} from '@share/ingestion';
import { ReferenceExporter, exporterPrincipal } from '@share/ingestion/testing';
import {
  MemoryAlerts, TOPIC_BINDINGS, TOPIC_HANDOFF, TOPIC_PARTS,
  type BindingFact, type ObservationPoint, type ObservationPointFact, type ProvisioningEvent, type ServiceTag,
} from '@share/rate-common';
import {
  CatalogueOwner, CatalogueReplica, RatingOwner, StageAOwner, StageBOwner, attrADeclaration, attrBDeclaration,
  catalogueDeclaration, ratingDeclaration, type FixtureEntity,
} from '../src/index.ts';
import { AccountOwnerDouble } from './account-owner.ts';
import { Bus } from './bus.ts';
import { LedgerDouble, SettlementDouble } from './settlement.ts';

const noSleep = async (): Promise<void> => {};

/** The provisioning producer (C11 Part III): contiguous bindingSeq for each exporter. */
export class ProvisioningProducer {
  private readonly seqs = new Map<string, bigint>();
  private readonly bus: Bus;
  constructor(bus: Bus) {
    this.bus = bus;
  }

  private async publish(exporterId: string, fact: ProvisioningEvent['fact']): Promise<void> {
    const seq = (this.seqs.get(exporterId) ?? 0n) + 1n;
    this.seqs.set(exporterId, seq);
    const ev: ProvisioningEvent = { schemaVersion: 1, exporterId, bindingSeq: seq.toString(), recordedAtMs: this.bus.nowMs, fact };
    await this.bus.publish(TOPIC_BINDINGS, exporterId, 'bindings', ev);
  }

  observationPoint(op: ObservationPoint, linkId: string | null, validFromMs: number): Promise<void> {
    const f: ObservationPointFact = { kind: 'observation-point', factId: `op-${op.exporterId}-${op.ifIndex}-${validFromMs}`,
      op, linkId, validFromMs, validToMs: null };
    return this.publish(op.exporterId, f);
  }

  binding(b: { op: ObservationPoint; serviceTag: ServiceTag; accountId: string; productId: string; routeId: string;
    reservationId?: string | null; egress?: boolean; validFromMs: number; bindingId?: string }): Promise<void> {
    const f: BindingFact = { kind: 'binding', factId: `b-${b.bindingId ?? 'b1'}-${b.validFromMs}`, bindingId: b.bindingId ?? 'b1',
      key: { op: b.op, serviceTag: b.serviceTag }, validFromMs: b.validFromMs, validToMs: null, accountId: b.accountId,
      productId: b.productId, routeId: b.routeId, reservationId: b.reservationId ?? null, egress: b.egress ?? true };
    return this.publish(b.op.exporterId, f);
  }

  /** A heartbeat; coverage at most binding_lead (60 s) ahead of now (C11 D57-1). */
  heartbeat(exporterId: string, coversThroughMs = this.bus.nowMs + 60_000): Promise<void> {
    return this.publish(exporterId, { kind: 'heartbeat', coversThroughMs });
  }
}

export interface WorldOptions {
  startMs: number;
  /** Deliver the hand-off and the part batches by the relay as well as (or instead of) the direct publish. */
  relay?: 'off' | 'both' | 'only';
  /** Destination partitions of the hand-off topic that rating waits for (default 1). */
  handoffPartitions?: number;
}

export function buildWorld(opts: WorldOptions) {
  const bus = new Bus(opts.startMs);
  const alerts = new MemoryAlerts();
  const mk = (declaration: typeof ingestDeclaration) => new RuntimeDouble({ declaration, startMs: opts.startMs });
  const rts = {
    ingest: mk(ingestDeclaration), catalogue: mk(catalogueDeclaration), attrA: mk(attrADeclaration),
    attrB: mk(attrBDeclaration), rating: mk(ratingDeclaration),
  };
  const ingest = new IngestOwner(rts.ingest, { alerts, sleep: noSleep });
  const catalogue = new CatalogueOwner(rts.catalogue, { alerts, sleep: noSleep });
  const rating = new RatingOwner(rts.rating, { catalogue: new CatalogueReplica(), homeLedgerPartition: LedgerDouble.home,
    handoffPartitions: opts.handoffPartitions ?? 1, alerts, sleep: noSleep });
  const stageA = new StageAOwner(rts.attrA, { catalogue: new CatalogueReplica(), alerts, sleep: noSleep,
    onWatermark: (dest, w) => { void rating.onStageAWatermark(dest, w); } });
  const stageB = new StageBOwner(rts.attrB, { rating, alerts, sleep: noSleep });
  rts.ingest.attach(ingest);
  rts.catalogue.attach(catalogue);
  rts.attrA.attach(stageA);
  rts.attrB.attach(stageB);
  rts.rating.attach(rating, (p, k) => rating.onTimer(p, k));
  bus.register('ingest', rts.ingest);
  bus.register('catalogue', rts.catalogue);
  bus.register('attr_a', rts.attrA, () => stageA.idle());
  bus.register('attr_b', rts.attrB, () => stageB.idle());
  bus.register('rating', rts.rating, () => rating.idle());
  const relay = opts.relay ?? 'off';
  if (relay !== 'off') {
    bus.relay(rts.ingest, TOPIC_HANDOFF, 'handoff', (row, streamSeq) =>
      emitHandoff(row.entry.payload as BatchEntryPayload, { logSeq: row.seq, ts: row.ts, handoffSeq: streamSeq }));
    bus.relay(rts.attrA, TOPIC_PARTS, 'parts');
  }
  if (relay === 'only') { bus.directOff.add(TOPIC_HANDOFF); bus.directOff.add(TOPIC_PARTS); }
  const settlementCatalogue = new CatalogueReplica();
  bus.on('catalogue.v1', (_ev, fe) => settlementCatalogue.applyFeedEvent(fe));
  const ledger = new LedgerDouble(() => bus.nowMs);
  const settlement = new SettlementDouble(bus, settlementCatalogue, ledger);
  const accountOwner = new AccountOwnerDouble(bus, ledger);
  const provisioning = new ProvisioningProducer(bus);

  async function deploy(entities: FixtureEntity[], deployment = 'deploy-1'): Promise<void> {
    for (const e of entities) {
      const r = await catalogue.write(e, deployment);
      if (!r.ok) throw new Error(`catalogue refused ${JSON.stringify(e)}: ${r.reason}`);
    }
    await bus.settle();
  }

  function session(exporterId: string, supplier: string, region: 'R1' | 'R2' = 'R1'): IngestSession {
    const s = ingest.openSession({ principal: exporterPrincipal({ supplier, region }), exporterId });
    if ('refused' in s) throw new Error(s.reason);
    s.onHello({ protocolVersion: 1, exportFormat: 'ipfix' }, bus.nowMs);
    return s;
  }

  return { bus, alerts, rts, ingest, catalogue, rating, stageA, stageB, settlement, ledger, accountOwner, provisioning,
    deploy, session, ReferenceExporter };
}

export type World = ReturnType<typeof buildWorld>;
