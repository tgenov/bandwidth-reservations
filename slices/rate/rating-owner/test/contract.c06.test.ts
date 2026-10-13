/**
 * C06 settlement and ledger suites against the settlement double of the rate slice (its §7 and §8 provider):
 * usage batches (runC06ProviderSuite) and reservation batches (runC06ReservationSuite).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  C06_SUITE_WEIGHTS, runC06ProviderSuite, runC06ReservationSuite, type C06LineAck, type C06ReservationSubject, type C06Subject,
} from '@share/contract-suites';
import type { CatalogueEntity, PostMovementRequest, PostingAck, SourceRef } from '@share/rate-common';
import { CatalogueReplica, TOPIC_CHARGES, TOPIC_POSTING_ACKS } from '../src/index.ts';
import { Bus, LedgerDouble, SettlementDouble, splitEntries } from '../testing/index.ts';

type SplitWeights = Extract<CatalogueEntity, { entityType: 'split_weights' }>;

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

/**
 * C06 §8 check 2 (D4) with two known weights versions, which the shared suite cannot give (contracts/suites/ISSUES.md
 * CS-11): an amendment whose entries follow the template of its own, known weights version, but not the version the
 * original was posted with, is invalid.
 */
test('C06 CT-L6 [settlement double] an amendment on a known weights version other than the original\'s is invalid and refuses the usage batch', () => {
  const versions: Record<string, SplitWeights> = {
    'w-a': { entityType: 'split_weights', route: ROUTE, weightsVersion: 'w-a', effectiveFrom: '2026-01-01T00:00:00Z', announcedAt: '0.0000000000',
      legs: [{ link: 'L1', supplier: 's1', weight: 7 }], commissionWeight: 3 },
    'w-b': { entityType: 'split_weights', route: ROUTE, weightsVersion: 'w-b', effectiveFrom: '2026-01-01T00:00:00Z', announcedAt: '0.0000000000',
      legs: [{ link: 'L1', supplier: 's1', weight: 1 }], commissionWeight: 1 },
  };
  const ledger = new LedgerDouble(() => START_MS, (v) => versions[v]);
  const ref = (seq: number): SourceRef => ({ kind: 'usage', account: 'b1', product: 'be', route: ROUTE, minute: '2026-10-12T09:00:00Z', seq });
  const req = (id: string, seq: number, p: bigint, n: bigint, v: string): PostMovementRequest => ({
    movementRef: id, cause: `charge batch ${id}`, currency: 'USD', batch: { id, kind: 'usage', lineCount: 1 },
    lines: [{ kind: seq === 0 ? 'M5' : 'M6', lineRef: ref(seq), lineKind: 'usage', payer: 'account', reason: seq === 0 ? 'original' : 'late_traffic',
      amendmentSeq: seq, priorTotal: p.toString(), newTotal: n.toString(), split: { route: ROUTE, weightsVersion: v, mode: 'normal' },
      entries: splitEntries('b1', p, n, versions[v] as SplitWeights) }],
  });
  assert.equal(ledger.post(req('m1', 0, 0n, 4285n, 'w-a'), 'b1').result, 'committed');
  const r = ledger.post(req('m2', 1, 4285n, 14285n, 'w-b'), 'b1');
  assert.deepEqual(r.result === 'refused_batch' ? r.lines.map((l) => l.problem) : r, ['invalid']);
  const ok = ledger.post(req('m3', 1, 4285n, 14285n, 'w-a'), 'b1');
  assert.equal(ok.result, 'committed', 'the refusal posted nothing');
  assert.deepEqual(ledger.movements.map((m) => m.lines[0]?.entries), [
    [{ ledgerAccount: 'B:b1', amount: '-4285' }, { ledgerAccount: 'S:s1:earn', amount: '3000' }, { ledgerAccount: 'SH:commission', amount: '1285' }],
    [{ ledgerAccount: 'B:b1', amount: '-10000' }, { ledgerAccount: 'S:s1:earn', amount: '7000' }, { ledgerAccount: 'SH:commission', amount: '3000' }],
  ]);
});
