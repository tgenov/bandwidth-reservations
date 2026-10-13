/**
 * C06 settlement and ledger suites against the settlement double of the rate slice (its §7 and §8 provider):
 * usage batches (runC06ProviderSuite) and reservation batches (runC06ReservationSuite).
 */
import {
  C06_SUITE_WEIGHTS, runC06ProviderSuite, runC06ReservationSuite, type C06LineAck, type C06ReservationSubject, type C06Subject,
} from '@share/contract-suites';
import type { PostingAck } from '@share/rate-common';
import { CatalogueReplica, TOPIC_CHARGES, TOPIC_POSTING_ACKS } from '../src/index.ts';
import { Bus, LedgerDouble, SettlementDouble } from '../testing/index.ts';

const START_MS = Date.UTC(2026, 9, 12, 9, 0, 0);
const ROUTE = 'route-1';
const WEIGHTS = 'w-1';
const SUPPLIER = 'sup-a';

function isPostingAck(e: unknown): e is PostingAck {
  return typeof e === 'object' && e !== null && 'type' in e && e.type === 'PostingAck';
}

runC06ProviderSuite('settlement double', async (): Promise<C06Subject> => {
  const bus = new Bus(START_MS);
  const catalogue = new CatalogueReplica();
  catalogue.applyEvent({
    type: 'CatalogueEvent', schemaVersion: 1,
    eventId: { partition: `split_weights:${WEIGHTS}`, stream: 'catalogue', streamSeq: '1', generation: 0, epoch: 1 },
    entityVersion: '1', committedAt: '0.0000000000', principal: 'commercial-1',
    body: { entityType: 'split_weights', route: ROUTE, weightsVersion: WEIGHTS, effectiveFrom: '2026-01-01T00:00:00Z',
      announcedAt: '0.0000000000', legs: [{ link: 'L1', supplier: SUPPLIER, weight: 1 }], commissionWeight: 0 },
  });
  const ledger = new LedgerDouble(() => bus.nowMs);
  new SettlementDouble(bus, catalogue, ledger);
  const acks: PostingAck[] = [];
  bus.on(TOPIC_POSTING_ACKS, (e) => { if (isPostingAck(e)) acks.push(e); });
  return {
    settle: async (batch): Promise<C06LineAck[]> => {
      await bus.publish(TOPIC_CHARGES, batch.batch.account, 'charges', batch);
      await bus.settle();
      return acks.filter((a) => a.batchId === batch.batch.id).flatMap((a) => a.lines);
    },
    post: async (req, account) => ledger.post(req, account),
    route: ROUTE, weightsVersion: WEIGHTS, supplier: SUPPLIER,
    integrityAlerts: () => ledger.integrityAlerts.length,
    close: async () => {},
  };
});

runC06ReservationSuite('settlement double', async (): Promise<C06ReservationSubject> => {
  const bus = new Bus(START_MS);
  const catalogue = new CatalogueReplica();
  catalogue.applyEvent({
    type: 'CatalogueEvent', schemaVersion: 1,
    eventId: { partition: `split_weights:${C06_SUITE_WEIGHTS.weightsVersion}`, stream: 'catalogue', streamSeq: '1', generation: 0, epoch: 1 },
    entityVersion: '1', committedAt: '0.0000000000', principal: 'commercial-1', body: C06_SUITE_WEIGHTS,
  });
  const ledger = new LedgerDouble(() => bus.nowMs, (v) => catalogue.weightsVersion(v));
  new SettlementDouble(bus, catalogue, ledger);
  const acks: PostingAck[] = [];
  bus.on(TOPIC_POSTING_ACKS, (e) => { if (isPostingAck(e)) acks.push(e); });
  return {
    settle: async (batch): Promise<C06LineAck[]> => {
      await bus.publish(TOPIC_CHARGES, batch.batch.account, 'charges', batch);
      await bus.settle();
      return acks.filter((a) => a.batchId === batch.batch.id).flatMap((a) => a.lines);
    },
    post: async (req, account) => ledger.post(req, account),
    integrityAlerts: () => ledger.integrityAlerts.length,
    close: async () => {},
  };
});
