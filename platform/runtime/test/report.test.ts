/**
 * Report position, read leases and the marker chain on the in-memory store (C01 §3.1, §3.4):
 * CP-7 (initial report position after expiry and resume; leases end inside the holder's view) and
 * CP-7a (chain with no gap and no overlap across a takeover; pendingAnswered; rule 7; chunks).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EntryInput, HlcTs, OwnerDeclaration, OwnerHooks, ReportMarker, SlotNo } from '../src/index.ts';
import { CockroachOwnerRuntime, ManualLoad, MemoryPublisher, compareHlc, slotOfPartition, utf8 } from '../src/index.ts';
import { MemoryStore } from '../testing/index.ts';

const DECL: OwnerDeclaration = {
  kind: 'account', slotCount: 4, statusReaders: true,
  entryKinds: [{ kind: 1, name: 'outcome', schemaVersions: [1], retention: '7y' }],
  projections: [],
  streams: [{ name: 'outcome', topic: 'account.outcome.v1', key: 'slot', emitFn: { version: 1 }, closure: 'none', reportGated: true, consumers: ['notifier'] }],
};
const AUDIT = { schema: 'audit.v1', principal: { principal_id: 'svc', kind: 'service', tenant: 'share' }, decided_at: 'commit', policy_version: 1 } as const;
const outcome = (id: string, pending = false): EntryInput => ({ kind: 1, schemaV: 1, identity: utf8(`i-${id}`), audit: AUDIT, payload: { id },
  emits: [{ stream: 'outcome', event: { id } }], ...(pending ? { pendingAnswered: utf8(id) } : {}) });
// The view (850 ms) is longer than a read lease (400 ms), as in production (2,900 ms).
const FAST = { sessionTtlMs: 900, sessionRenewMs: 100, renewRetryMs: 50, holderViewMs: 850, maxLoopDelayMs: 50 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 3_000, what = f.toString()): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(5); }
}

interface Rec extends OwnerHooks { reportable: SlotNo[] }
function hooks(): Rec {
  const r: Rec = { reportable: [], async onAcquire() {}, onRelease() {}, onReportable(s) { r.reportable.push(s); }, onMovedOut() {}, async onAdopt() {}, async onNotification() {} };
  return r;
}

async function boot(store: MemoryStore, slots: SlotNo[], extra: { markerChunkMax?: number; wait?: number } = {}) {
  store.seedSlots('account', 4);
  const h = hooks();
  const rt = new CockroachOwnerRuntime({ declaration: DECL, store, slots, publisher: new MemoryPublisher(), load: new ManualLoad(),
    testing: { sessionTimings: FAST, postAcquisitionWaitMs: extra.wait ?? 60, ...(extra.markerChunkMax ? { markerChunkMax: extra.markerChunkMax } : {}) } });
  await rt.start(h);
  return { rt, h };
}

const P = utf8('acct-1');
const S = slotOfPartition(P, 4);
const ids = (m: ReportMarker): string[] => m.pendingAnswered.map((x) => Buffer.from(x).toString());

test('CP-7: no report and no lease before read_lease + ε after the acquisition; P starts at the catch-up read; leases end inside the view', async () => {
  const store = new MemoryStore();
  const before = store.nowTs();
  const { rt, h } = await boot(store, [S], { wait: 150 });
  assert.equal(rt.reportPosition(S), undefined);
  const now = () => process.hrtime.bigint();
  assert.deepEqual(rt.grantReadLease({ slot: S, readerId: 'r1', appliedThrough: before, sendMonotonic: now() }), { granted: false, reason: 'notReportable' });
  await until(() => h.reportable.includes(S));
  const p0 = rt.reportPosition(S) as HlcTs;
  assert.equal(compareHlc(p0, before), 1, 'initial position = the catch-up read, after the acquisition');
  const tooOld = rt.grantReadLease({ slot: S, readerId: 'r1', appliedThrough: before, sendMonotonic: now() });
  assert.deepEqual(tooOld, { granted: false, reason: 'notApplied' });
  const g = rt.grantReadLease({ slot: S, readerId: 'r1', appliedThrough: p0, sendMonotonic: now() });
  assert.ok(g.granted);
  if (g.granted) assert.ok(compareHlc(g.pGrant, p0) >= 0, 'no P_grant below the catch-up read');
  // A send whose 400 ms lease would end after the holder's view is refused (here the view is 850 ms).
  assert.deepEqual(rt.grantReadLease({ slot: S, readerId: 'r2', appliedThrough: p0, sendMonotonic: now() + 900_000_000n }), { granted: false, reason: 'outsideView' });
  await rt.stop();
});

test('CP-7: resume sets P to T_res and calls onReportable at once; P_grant never below T_res; a stalled reader holds P back', async () => {
  const store = new MemoryStore();
  const { rt, h } = await boot(store, [S], { wait: 40 });
  await until(() => h.reportable.length === 1);
  // A reader that applies nothing past its first answer holds P back while it has a live lease.
  let frozen: HlcTs | undefined;
  rt.attachReader('slow', { apply: async (_s, t) => { frozen ??= t; return frozen; } });
  await sleep(150);
  const g = rt.grantReadLease({ slot: S, readerId: 'slow', appliedThrough: rt.reportPosition(S) as HlcTs, sendMonotonic: process.hrtime.bigint() });
  assert.ok(g.granted);
  const c = await rt.append({ partition: P, entries: [outcome('x')] });
  assert.equal(c.r, 'Committed');
  await sleep(60);
  assert.ok(c.r === 'Committed' && compareHlc(rt.reportPosition(S) as HlcTs, c.ts) < 0, 'P does not pass a reader with a live lease');
  rt.detachReader('slow');
  await until(() => c.r === 'Committed' && compareHlc(rt.reportPosition(S) as HlcTs, c.ts) >= 0);
  // A lapse, then a renewal: resume (no onAcquire), P = T_res > every commit, onReportable without a wait.
  rt.lapseForTest();
  await until(() => h.reportable.length === 2, 2_000);
  const p = rt.reportPosition(S) as HlcTs;
  assert.ok(c.r === 'Committed' && compareHlc(p, c.ts) > 0);
  const g2 = rt.grantReadLease({ slot: S, readerId: 'r', appliedThrough: p, sendMonotonic: process.hrtime.bigint() });
  assert.ok(g2.granted && compareHlc(g2.pGrant, p) >= 0);
  await rt.stop();
});

test('CP-7a: markers chain per slot (prev = last report_through, null only first); pendingAnswered of pending outcomes only; chunks', async () => {
  const store = new MemoryStore();
  const { rt, h } = await boot(store, [S], { markerChunkMax: 2 });
  await until(() => h.reportable.length === 1);
  await until(() => rt.markersWritten.length === 1);            // the first marker after the acquisition
  const first = rt.markersWritten[0] as ReportMarker;
  assert.equal(first.prevReportPosition, null, 'null only for the slot\'s first marker');
  await rt.append({ partition: P, entries: [outcome('q1', true), outcome('n1'), outcome('q2', true), outcome('q3', true)] });
  await until(() => rt.markersWritten.length >= 3);
  const ms = rt.markersWritten;
  const sets = groupBySet(ms);
  for (let i = 1; i < sets.length; i++) assert.equal(sets[i]?.[0]?.prevReportPosition, sets[i - 1]?.[0]?.reportPosition, 'no gap and no overlap');
  const last = sets[sets.length - 1] as ReportMarker[];
  assert.deepEqual(last.map((m) => m.chunk), [{ part: 0, last: false }, { part: 1, last: true }], 'three ids in chunks of two');
  assert.deepEqual(last.flatMap(ids).sort(), ['q1', 'q2', 'q3'], 'only requests with pending sent');
  assert.equal(store.slotRow('account', S)?.reportThrough, last[0]?.reportPosition);
  assert.equal(store.slotRow('account', S)?.markerSeq, BigInt(ms.length));
  await rt.stop();
});

test('CP-7a trace: the holder sends pending for q and crashes before the covering marker; the successor\'s first marker lists q (rule 7)', async () => {
  const store = new MemoryStore();
  const a = await boot(store, [S], { wait: 30 });
  await until(() => a.rt.markersWritten.length === 1);
  const aLast = a.rt.markersWritten[0] as ReportMarker;
  // Hold A's P back with a reader that never applies, so A's next outcomes stay unmarked.
  a.rt.attachReader('stuck', { apply: async () => aLast.reportPosition });
  const renew = () => a.rt.grantReadLease({ slot: S, readerId: 'stuck', appliedThrough: aLast.reportPosition, sendMonotonic: process.hrtime.bigint() });
  assert.ok(renew().granted);
  // The reader renews every heartbeat until A's view ends (a lease never outlives the holder's view).
  const keep = setInterval(renew, 100);
  assert.equal((await a.rt.append({ partition: P, entries: [outcome('q', true), outcome('plain')] })).r, 'Committed');
  await sleep(40);
  assert.equal(a.rt.markersWritten.length, 1, 'no covering marker from A');
  a.rt.pauseRenewalsForTest();                  // A "crashes"
  const b = await boot(store, [S], { wait: 30 });
  await until(() => b.rt.heldSlots().includes(S), 5_000);
  await until(() => b.rt.markersWritten.length === 1, 5_000);
  clearInterval(keep);
  assert.equal(a.rt.markersWritten.length, 1, 'A wrote no covering marker before its view ended');
  const bFirst = b.rt.markersWritten[0] as ReportMarker;
  assert.equal(bFirst.prevReportPosition, aLast.reportPosition, 'prev = the predecessor\'s last marker of this slot');
  assert.ok(bFirst.epoch > aLast.epoch);
  // Rule 7: q (pending: its request id) and the plain outcome (no pending: the entry identity).
  assert.deepEqual(ids(bFirst).sort(), ['i-plain', 'q'], 'every covered outcome above prev');
  await a.rt.stop().catch(() => {}); await b.rt.stop();
});

function groupBySet(ms: ReportMarker[]): ReportMarker[][] {
  const out: ReportMarker[][] = [];
  for (const m of ms) {
    if (m.chunk.part === 0) out.push([m]); else out[out.length - 1]?.push(m);
  }
  return out;
}
