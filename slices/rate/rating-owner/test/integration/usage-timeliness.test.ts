/**
 * S-RATE-I4 exit criterion 7 (X2-S13): at steady load, each usage line is posted not later than 300 s
 * (`max_lateness` + 120 s) after the end of its minute; the design point is about 258 s (RFC-003 §5.12).
 *
 * Rating runs on the real C01 runtime and CockroachDB of the dev cell. Stage B is the in-process hand-off
 * (`applyParts`), so attribution is not measured here. The account owner and settlement are stand-ins on the
 * feed bus: each figure gets its UsageApplied, and each usage batch gets a `posted` acknowledgement at once. So
 * the measurement is the closure (m + 255 s), publish before emit and rating's own transactions.
 *
 * It runs only with RATE_MEASURE=1 (`npm run measure`), by hand: it takes real minutes (the closure is 255 s
 * after the minute's end), and a wall-clock bound fails on a loaded machine. RATE_MEASURE_STRICT=0 reports the
 * numbers without the bound. RATE_MEASURE_ACCOUNTS (default 20) and RATE_MEASURE_MINUTES (default 2) set the load.
 * The test skips when CockroachDB is not reachable, and fails instead with REQUIRE_DEV_CELL=1. It has its own
 * database and closes the runtime, the store and the bus in `finally`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  CockroachOwnerRuntime, ManualLoad, MemoryBus, MemoryPublisher, PgStore, decodeJson, encodeJson, hlcFromWallMs, slotOfPartition,
  systemClock, utf8,
} from '@share/owner-runtime';
import { migrateKinds } from '@share/owner-migrate';
import { createTestDatabase, devCellSkip } from '@share/owner-runtime/testing';
import type { ChargeLineBatch, Part, PostingAck, UnpostedUsageFigure, UsageApplied } from '@share/rate-common';
import {
  CatalogueReplica, RatingOwner, TOPIC_CHARGES, TOPIC_POSTING_ACKS, TOPIC_UNPOSTED, TOPIC_USAGE_APPLIED, ratingDeclaration,
} from '../../src/index.ts';

const URL = process.env['DATABASE_URL'] ?? 'postgresql://root@localhost:26257/defaultdb?sslmode=disable';
const enabled = process.env['RATE_MEASURE'] === '1';
const strict = process.env['RATE_MEASURE_STRICT'] !== '0';
const ACCOUNTS = Number(process.env['RATE_MEASURE_ACCOUNTS'] ?? '20');
const MINUTES = Number(process.env['RATE_MEASURE_MINUTES'] ?? '2');
/** X2-S13: max_lateness (180 s) + 120 s after the end of the minute. */
const BOUND_MS = 300_000;

async function dbReachable(): Promise<string | undefined> {
  const c = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 1_500 });
  try { await c.connect(); await c.query('SELECT 1'); return undefined; } catch (e) { return (e as { code?: string }).code ?? String(e); } finally { await c.end().catch(() => {}); }
}

const SKIP = !enabled ? 'set RATE_MEASURE=1 (npm run measure)' : devCellSkip((await dbReachable()) === undefined ? undefined : `CockroachDB at ${URL}`);
const FAST = { sessionTtlMs: 1_500, sessionRenewMs: 200, renewRetryMs: 100, holderViewMs: 1_400, maxLoopDelayMs: 100 };

/** Wait for a condition, with a bound (engineering.md §5). */
async function until(what: string, ok: () => boolean, ms: number): Promise<void> {
  const end = systemClock() + ms;
  while (!ok()) {
    if (systemClock() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function catalogue(): CatalogueReplica {
  const c = new CatalogueReplica();
  const ev = (seq: number, body: Parameters<CatalogueReplica['applyEvent']>[0]['body']) => c.applyEvent({
    type: 'CatalogueEvent', schemaVersion: 1, eventId: { partition: `e${seq}`, stream: 'catalogue', streamSeq: '1', generation: 0, epoch: 1 },
    entityVersion: '1', committedAt: '0.0000000000', principal: 'deploy-1', body,
  });
  ev(1, { entityType: 'price_version', product: 'be', route: 'r1', priceKind: 'usage_price', priceVersion: 'pv1', price: '10000000000',
    effectiveFrom: '2026-01-01T00:00:00Z', announcedAt: '0.0000000000' });
  ev(2, { entityType: 'split_weights', route: 'r1', weightsVersion: 'w1', effectiveFrom: '2026-01-01T00:00:00Z', announcedAt: '0.0000000000',
    legs: [{ link: 'L1', supplier: 's1', weight: 7 }], commissionWeight: 3 });
  return c;
}

const percentile = (xs: number[], p: number): number => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)] ?? NaN;

test('X2-S13 measurement: at steady load each usage line is posted not later than 300 s after the end of its minute (design about 258 s)',
  { skip: SKIP, timeout: (MINUTES + 8) * 60_000 }, async () => {
  const db = await createTestDatabase(URL, 'itest_rate_timeliness');
  const store = new PgStore({ connectionString: db.url });
  const bus = new MemoryBus();
  const publisher = new MemoryPublisher();
  const accounts = Array.from({ length: ACCOUNTS }, (_, i) => `a${i}`);
  const slots = [...new Set(accounts.map((a) => slotOfPartition(utf8(a), ratingDeclaration.slotCount)))];
  let rt: CockroachOwnerRuntime | undefined;
  let pump: ReturnType<typeof setInterval> | undefined;
  try {
    await migrateKinds(db.url, [ratingDeclaration], { presplit: false });
    let rating: RatingOwner | undefined;
    rt = new CockroachOwnerRuntime({ declaration: ratingDeclaration, store, slots, publisher, load: new ManualLoad(),
      feeds: { bus, groupId: 'rating' }, onTimer: (p, k) => rating?.onTimer(p, k), testing: { sessionTimings: FAST } });
    rating = new RatingOwner(rt, { catalogue: catalogue(), homeLedgerPartition: (a) => `L:${a}` });
    await rt.start(rating);
    const runtime = rt;
    await until('rating slots acquired', () => slots.every((s) => runtime.heldSlots().includes(s)), 15_000);

    // Stand-ins for the account owner (C06 §4) and settlement (C06 §7), on the feed bus.
    const streamSeqs = new Map<string, number>();
    const produce = async (topic: string, account: string, stream: string, event: unknown): Promise<void> => {
      const k = `${topic}|${account}`;
      const seq = (streamSeqs.get(k) ?? 0) + 1;
      streamSeqs.set(k, seq);
      await bus.produce(topic, [{ key: utf8(account), value: encodeJson(event), headers: { partition: utf8(account), stream,
        stream_seq: String(seq), generation: '0', epoch: '1', ts: hlcFromWallMs(systemClock()), kind: '1', schema_v: '1', key_id: '00' } }]);
    };
    const ledgerSeq = new Map<string, number>();
    const postedAt: Array<{ minuteEndMs: number; atMs: number }> = [];
    let seen = 0;
    let busy = false;
    pump = setInterval(() => {
      if (busy) return;
      busy = true;
      void (async () => {
        for (; seen < publisher.sent.length; seen++) {
          const m = publisher.sent[seen];
          if (!m) continue;
          if (m.topic === TOPIC_UNPOSTED) {
            const f = decodeJson(m.value) as UnpostedUsageFigure;
            const ua: UsageApplied = { type: 'UsageApplied', schemaVersion: 1,
              eventId: { partition: f.account, stream: 'usage_applied', streamSeq: '1', generation: 0, epoch: 1 },
              account: f.account, appliedThrough: f.ratingPosition, appliedTs: hlcFromWallMs(systemClock()), entry: { partition: f.account, sequence: '1' } };
            await produce(TOPIC_USAGE_APPLIED, f.account, 'usage_applied', ua);
          } else if (m.topic === TOPIC_CHARGES) {
            const b = decodeJson(m.value) as ChargeLineBatch;
            const seq = (ledgerSeq.get(b.batch.account) ?? 0) + 1;
            ledgerSeq.set(b.batch.account, seq);
            const position = { ledgerPartition: `L:${b.batch.account}`, sequence: String(seq), commitTs: hlcFromWallMs(systemClock()) };
            const ack: PostingAck = { type: 'PostingAck', schemaVersion: 1,
              eventId: { partition: b.batch.account, stream: 'posting_acks', streamSeq: String(seq), generation: 0, epoch: 1 },
              account: b.batch.account, batchId: b.batch.id,
              lines: b.lines.map((l) => ({ sourceRef: l.sourceRef, outcome: 'posted' as const, duplicate: false, position,
                movementId: `L:${b.batch.account}/${seq}`, postedAmount: l.amount, postedTotal: l.newTotal })) };
            for (const l of b.lines) postedAt.push({ minuteEndMs: Date.parse(l.minute ?? '') + 60_000, atMs: systemClock() });
            await produce(TOPIC_POSTING_ACKS, b.batch.account, 'posting_acks', ack);
          }
        }
      })().finally(() => { busy = false; });
    }, 20);

    // Steady load: one part a second for each account, for MINUTES whole minutes; the stage A watermark follows the clock.
    const firstMinute = Math.ceil(systemClock() / 60_000) * 60_000;
    await until('the first whole minute', () => systemClock() >= firstMinute, 61_000);
    let attrB = 0;
    while (systemClock() < firstMinute + MINUTES * 60_000) {
      const now = systemClock();
      const minuteMs = now - (now % 60_000);
      attrB += 1;
      for (const account of accounts) {
        const part: Part = {
          recordIdentity: { kind: 'record', id: { format: 'ipfix', exporterId: 'e1', observationDomain: 7, epoch: 1, extSeq: String(attrB) } },
          bindingPosition: '1', acceptedAtMs: now, lastMinuteEndMs: minuteMs + 60_000, minuteMs, bytes: { num: '1000000', den: '1' },
          class: 'best-effort', accountId: account, productId: 'be', routeId: 'r1', reservationId: null,
          op: { exporterId: 'e1', observationDomain: 7, ifIndex: 3, direction: 'egress' }, linkId: 'L1',
        };
        await rating.applyParts({ account, attrBSeq: String(attrB), parts: [part], bindingFacts: [] });
      }
      await rating.onStageAWatermark(0, now - 1_000);
      await new Promise((r) => setTimeout(r, Math.max(0, 1_000 - (systemClock() - now))));
    }
    const lines = ACCOUNTS * MINUTES;
    const watermarkTimer = setInterval(() => { void rating.onStageAWatermark(0, systemClock() - 1_000); }, 1_000);
    try {
      await until(`${lines} usage lines posted`, () => postedAt.length >= lines, 7 * 60_000);
    } finally {
      clearInterval(watermarkTimer);
    }
    const lateness = postedAt.map((p) => p.atMs - p.minuteEndMs);
    const p50 = percentile(lateness, 0.5);
    const p99 = percentile(lateness, 0.99);
    console.log(`# X2-S13 usage lines: ${lateness.length}, posted after the minute's end p50 ${p50} ms, p99 ${p99} ms, max ${Math.max(...lateness)} ms`);
    assert.equal(postedAt.length, lines, 'each usage line is posted once');
    if (strict) assert.ok(p99 <= BOUND_MS, `p99 ${p99} ms > ${BOUND_MS} ms`);
  } finally {
    if (pump) clearInterval(pump);
    await rt?.stop();
    await store.close();
    await db.drop();
  }
});
