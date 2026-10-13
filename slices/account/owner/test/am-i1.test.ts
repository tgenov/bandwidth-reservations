/**
 * AM-I1 walking skeleton (S-ACCT-S-MONEY plan §6): scenarios P2-S11, P2-S92, P4-S08, P4-S09, P4-S59,
 * and the exit criteria (1) … (10), on the S-PLAT runtime double and a C02 link double.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { EntryInput, HlcTs } from '@share/owner-runtime';
import { compareHlc, utf8, validateDeclaration } from '@share/owner-runtime';
import { RESULTS } from '@share/owner-runtime/testing';
import { kindMigration } from '@share/owner-migrate';
import {
  ENTRY, MOVEMENT_FEED_TOPIC, accountDeclaration, balanceOf, emptyFundsState, fundsModule, reservationHold, time,
  type BookRequest, type C05, type C10Answer, type RequestStatus, type FundsModule, type OutcomeEvent, type Confirmed,
} from '@share/account-owner';
import { NINE_AM_MS, PRODUCT, agentContext, harness, movementM1, windowAt } from '@share/account-owner/testing';

const book = (start: number, end: number | null, rate: number, extra: Partial<BookRequest> = {}): BookRequest =>
  ({ legs: ['L1'], window: windowAt(NINE_AM_MS, start, end), rate_mbps: rate, product_id: PRODUCT, ...extra });

const ONE_USD = 1_000_000n;
const S = (a: C10Answer): string | undefined => (a.body as RequestStatus).state;

type LogRow = { seq: bigint; ts: HlcTs; entry: EntryInput; streamSeqs: Array<{ stream: string; streamSeq: bigint }> };
function entriesOf(h: { rt: { log(p: Uint8Array): LogRow[] } }, account: string): LogRow[] {
  return h.rt.log(utf8(account));
}

function bookingPayload(e: EntryInput): Record<string, unknown> {
  return (e.payload as { booking: Record<string, unknown> }).booking;
}

// ---------------- Scenarios ----------------

test('P4-S08: confirming an open-ended reservation of 100 Mbps from now holds 0.288000 USD (24 h of charges) and charges nothing', async () => {
  const h = await harness({ accounts: [{ account: 'b1', balanceMicros: ONE_USD }] });
  const a = await h.book('b1', 'p4-s08', book(0, null, 100));
  assert.equal(a.http, 200);
  assert.equal(S(a), 'confirmed');
  const st = h.owner.accountState('b1')!;
  assert.equal(reservationHold(st.funds, a.body.reservation_id!), 288_000n);
  assert.equal(balanceOf(st.funds), ONE_USD);
});

test('P4-S09: a reservation of 100 Mbps for 2 h is held in full, 0.024000 USD', async () => {
  const h = await harness({ accounts: [{ account: 'b1', balanceMicros: ONE_USD }] });
  const a = await h.book('b1', 'p4-s09', book(0, 120, 100));
  assert.equal(a.http, 200);
  assert.equal(reservationHold(h.owner.accountState('b1')!.funds, (a.body as { reservation_id: string }).reservation_id), 24_000n);
});

for (const [row, end, held] of [['open-ended reservation of 100 Mbps', null, 288_000n], ['reservation of 100 Mbps for 2 h', 120, 24_000n]] as const) {
  test(`P4-S59: ${row} starting in 30 days has ${held} µ held from the moment it is confirmed until it starts`, async () => {
    const h = await harness({ accounts: [{ account: 'b1', balanceMicros: ONE_USD }] });
    const startMin = 30 * 1_440;
    const a = await h.book('b1', `p4-s59-${row}`, book(startMin, end === null ? null : startMin + end, 100));
    assert.equal(a.http, 200);
    assert.equal(S(a), 'confirmed');
    const st = h.owner.accountState('b1')!;
    assert.equal(reservationHold(st.funds, (a.body as { reservation_id: string }).reservation_id), held);
    assert.equal(balanceOf(st.funds), ONE_USD, 'the ledger balance of b1 is still 1.000000 USD');
  });
}

test('P2-S11: a request without a deadline gets route_deadline_default (30 s) after it was received', async () => {
  const h = await harness({ accounts: [{ account: 'b1', balanceMicros: ONE_USD }] });
  const a = await h.book('b1', 'p2-s11', book(0, 60, 1));
  assert.equal(a.http, 200);
  const e1 = entriesOf(h, 'b1').find((e) => e.entry.kind === ENTRY.E1)!;
  const rec = bookingPayload(e1.entry);
  assert.equal(rec['requestAge'], e1.ts);
  assert.equal(Number(rec['D']) - time.wallMs(e1.ts), 30_000);
  assert.equal(Number(rec['Dc']), Number(rec['D']) - h.rt.timing().tauMs);
  assert.equal((a.body as RequestStatus).deadline, time.isoMs(time.wallMs(e1.ts) + 30_000));
});

test('P2-S92: a request holds no capacity until its funds hold is taken; the other buyer is decided without waiting', async () => {
  const h = await harness({
    accounts: [{ account: 'b1', balanceMicros: 500n }, { account: 'b2', balanceMicros: ONE_USD }],
    links: [{ link: 'L', capacityMbps: 10 }],
  });
  const body = (k: string): BookRequest => ({ legs: ['L'], window: windowAt(NINE_AM_MS, 60, 120), rate_mbps: 8, product_id: PRODUCT, ...(k ? {} : {}) });
  const [a1, a2] = await Promise.all([h.book('b1', 'q1', body('b1')), h.book('b2', 'q2', body('b2'))]);
  assert.equal(a1.http, 200);
  assert.equal(S(a1), 'rejected');
  assert.equal((a1.body as { reason: string }).reason, 'insufficient_funds');
  assert.equal(a2.http, 200);
  assert.equal(S(a2), 'confirmed');
  // b1 never held capacity on L; b2 did.
  assert.deepEqual(h.links.calls.filter((c) => c.op === 'hold').map((c) => Buffer.from(c.cmd.request.partition).toString()), ['b2']);
  // Instrumented trace: no hold leaves before the E1 of its request commits.
  for (let i = 0; i < h.rt.events.length; i++) {
    const ev = h.rt.events[i]!;
    if (!ev.startsWith('hold:')) continue;
    const req = ev.slice('hold:'.length);
    const e1 = h.rt.events.indexOf(`commit:${ENTRY.E1}:${req}`);
    assert.ok(e1 >= 0 && e1 < i, `hold for ${req} at ${i} after its E1 at ${e1}`);
  }
});

// ---------------- Exit criteria ----------------

test('should answer 200 confirmed with a reservation id, and the link records hold then convert with the attempt HELD carried, when POST book is for one Share leg (AM-I1 exit 1)', async () => {
  const h = await harness({ accounts: [{ account: 'b1', balanceMicros: ONE_USD }] });
  const a = await h.book('b1', 'exit-1', book(0, 60, 10));
  assert.equal(a.http, 200);
  assert.equal(S(a), 'confirmed');
  assert.match((a.body as { reservation_id: string }).reservation_id, /^rsv-/);
  const ops = h.links.calls.map((c) => c.op);
  assert.deepEqual(ops, ['hold', 'convert']);
  const conv = h.links.calls[1]!.cmd as { attempt: number; createdBy: { seq: bigint }; decisionTime: HlcTs };
  assert.equal(conv.attempt, 1);
  const e5 = entriesOf(h, 'b1').find((e) => e.entry.kind === ENTRY.E5)!;
  assert.equal(conv.createdBy.seq, e5.seq);
  assert.equal(conv.decisionTime, e5.ts);
});

test('should refuse with C10 reason insufficient_funds and both top-up amounts (x − h, x − h + LBW) when a booking exceeds the funds (AM-I1 exit)', async () => {
  const h = await harness({ accounts: [{ account: 'b1', balanceMicros: 500n }] });
  const a = await h.book('b1', 'nofunds', book(60, 120, 8));      // x = 8 Mbps × 2 µ × 60 min = 960 µ; h = 500 µ
  assert.equal(a.http, 200);
  assert.equal(S(a), 'rejected');
  const b = a.body as { reason: string; amounts: { top_up_min: { micros: string }; top_up_min_plus_low_balance_warning: { micros: string } } };
  assert.equal(b.reason, 'insufficient_funds');
  assert.deepEqual(b.amounts.top_up_min, { currency: 'USD', micros: '460' });
  assert.deepEqual(b.amounts.top_up_min_plus_low_balance_warning, { currency: 'USD', micros: '1000460' });
  const e = entriesOf(h, 'b1').find((x) => x.entry.kind === ENTRY.E1p)!;
  const ev = h.rt.published.find((p) => p.topic === 'account.outcome.v1')!.event as OutcomeEvent;
  assert.deepEqual(ev.reason, { code: 'insufficient_funds', needed: '960', available: '500' });
  assert.equal(ev.decided_ts, e.ts);
  assert.equal(h.links.calls.length, 0, 'nothing held on any link');
});

test('should give the same answer for the same Idempotency-Key (retry and parallel), and 409, when the fingerprint or the principal changes (AM-I1 exit)', async () => {
  const h = await harness({ accounts: [{ account: 'b1', balanceMicros: ONE_USD, keys: ['k1', 'k2'] }] });
  const [x, y] = await Promise.all([h.book('b1', 'same', book(0, 60, 10)), h.book('b1', 'same', book(0, 60, 10))]);
  assert.deepEqual(x, y);
  const retry = await h.book('b1', 'same', book(0, 60, 10, { deadline_ms: 45_000 }));   // the deadline is not a fingerprint field
  assert.deepEqual(retry, x);
  assert.equal(entriesOf(h, 'b1').filter((e) => e.entry.kind === ENTRY.E1).length, 1, 'one request');
  assert.equal(h.links.calls.filter((c) => c.op === 'hold').length, 1);
  assert.deepEqual(await h.book('b1', 'same', book(0, 60, 11)), { http: 409, body: { error: 'not_accepted', code: 'key_reuse_different_request' } });
  assert.deepEqual(await h.book('b1', 'same', book(0, 60, 10), 'b1-k2'), { http: 409, body: { error: 'not_accepted', code: 'key_reuse_other_principal' } });
  // An invalid request is recorded under its key, and a retry returns it.
  const inv1 = await h.book('b1', 'bad', book(0, 60, 10, { deadline_ms: 61_000 }));
  const inv2 = await h.book('b1', 'bad', book(0, 60, 10, { deadline_ms: 61_000 }));
  assert.equal(S(inv1), 'invalid');
  assert.equal((inv1.body as { reason: string }).reason, 'invalid_deadline');
  assert.deepEqual(inv2, inv1);
});

test('should never say pending in a status read when an outcome is reported (AM-I1 exit)', async () => {
  const h = await harness({ accounts: [{ account: 'b1', balanceMicros: ONE_USD }], autoReport: false });
  h.links.holdDelayMs = 250;                        // the hold answers after the ack budget: pending goes before E5 is formed
  const slot = h.rt.slotOf(utf8('b1')).slot;
  h.rt.reportUpTo(slot, h.rt.now().ts);
  const a = await h.book('b1', 'st', book(0, 60, 10));
  assert.equal(a.http, 202, 'not reported within the ack budget: pending, for a durable intake');
  assert.equal(S(a), 'pending');
  assert.equal(S(h.status('b1', 'st')), 'pending');
  await waitFor(() => entriesOf(h, 'b1').some((e) => e.entry.kind === ENTRY.E5));
  const e5 = entriesOf(h, 'b1').find((e) => e.entry.kind === ENTRY.E5)!;
  assert.equal(S(h.status('b1', 'st')), 'pending', 'E5 committed but not reported: pending, never the outcome early');
  // E5 is committed, but not yet at the report position: the read answers pending, never the outcome early.
  h.rt.setLease(slot, false);
  assert.equal(h.status('b1', 'st').http, 503, 'no lease and not reported: refuse with a retry, never a guess');
  h.rt.setLease(slot, true);
  h.rt.reportUpTo(slot, e5.ts);
  const reads = [h.status('b1', 'st')];
  h.rt.setLease(slot, false);                       // the reader loses its lease: a reported outcome is still answered
  reads.push(h.status('b1', 'st'));
  h.rt.setLease(slot, true);
  reads.push(h.status('b1', 'st'), await h.book('b1', 'st', book(0, 60, 10)));
  for (const r of reads) {
    assert.equal(r.http, 200);
    assert.equal(S(r), 'confirmed');
  }
  assert.equal(h.status('b1', 'never-used').http, 404);
  const ev = h.rt.published.find((p) => p.topic === 'account.outcome.v1')!.event as OutcomeEvent;
  assert.equal(ev.answered_pending, true, 'pending was sent before E5 was formed');
  assert.ok(e5.entry.pendingAnswered, 'C01 EntryInput.pendingAnswered set on the reporting entry');
});

test('should cost two account-log transactions when a single-link booking is made (AM-I1 exit 10)', async () => {
  const h = await harness({ accounts: [{ account: 'b1', balanceMicros: ONE_USD }] });
  const before = h.rt.appends.filter((a) => Buffer.from(a.call.partition).toString() === 'b1').length;
  await h.book('b1', 'count', book(0, 60, 10));
  const after = h.rt.appends.filter((a) => Buffer.from(a.call.partition).toString() === 'b1');
  assert.equal(after.length - before, 2);
  assert.ok(after.slice(before).every((a) => a.result.r === 'Committed'));
});

test('C05 H1: admit and apply run only inside the batch transaction; a pushed transaction re-evaluates and the committed verdict equals a replay', async () => {
  let ownerRef: { deciding: boolean } | undefined;
  const outside: string[] = [];
  const watched: FundsModule & { keyStatus: typeof fundsModule.keyStatus } = {
    ...fundsModule,
    admit: (s, c, a) => { if (!ownerRef?.deciding) outside.push('admit'); return fundsModule.admit(s, c, a); },
    apply: (s, c, i) => { if (ownerRef && !ownerRef.deciding) outside.push(`apply:${i.kind}`); return fundsModule.apply(s, c, i); },
  };
  const h = await harness({ accounts: [{ account: 'b1', balanceMicros: ONE_USD }], funds: watched });
  ownerRef = h.owner;
  h.rt.scriptRestarts(2);
  const idx = h.rt.appends.length;
  await h.book('b1', 'h1', book(0, 60, 10));
  assert.deepEqual(outside, []);
  assert.equal(h.rt.decideRuns[idx], 3, 'decide ran once per restart');
  const e1 = entriesOf(h, 'b1').find((e) => e.entry.kind === ENTRY.E1)!;
  const f = (e1.entry.payload as { funds: { ask: C05.Ask; verdict: C05.Verdict; rules: string } }).funds;
  const replayed = replayFunds(entriesOf(h, 'b1'), 'b1', e1.seq);
  assert.equal(stable(replayed.verdict), stable(f.verdict));
});

test('C05 P1: replay of the account log on the module reproduces every recorded verdict and outcome (E1, E1′, E5, F1, F4, F10); the module reads no clock', async () => {
  const h = await harness({ accounts: [{ account: 'b1', balanceMicros: 20_000n }] });
  await h.book('b1', 'r1', book(0, 60, 100));      // 12,000 µ: admitted
  await h.book('b1', 'r2', book(0, 60, 100));      // refused: insufficient funds
  await h.book('b1', 'r3', book(0, 30, 10));       // 600 µ: admitted
  const log = entriesOf(h, 'b1');
  assert.ok(log.some((e) => e.entry.kind === ENTRY.E1p));
  replayFunds(log, 'b1');
  const src = readFileSync(new URL('../src/funds/module.ts', import.meta.url), 'utf8');
  for (const banned of ['Date.', 'Math.random', 'performance.', 'process.', 'setTimeout', 'Number(']) {
    assert.equal(src.includes(banned), false, `the funds module uses ${banned}`);
  }
});

test('C01 CC-1: every AppendResult on the intake gives the C01 §3.2 action; no answer before Committed; the same identities on retry', async () => {
  const cases: Array<[string, () => import('@share/owner-runtime').AppendResult, number | 'confirmed']> = [
    ['Retry', RESULTS.Retry, 'confirmed'],
    ['Ambiguous', RESULTS.Ambiguous, 'confirmed'],
    ['Moving', RESULTS.Moving, 'confirmed'],
    ['Overloaded', () => RESULTS.Overloaded(5), 'confirmed'],
    ['unknown', RESULTS.Unknown, 'confirmed'],
    ['StaleEpoch', RESULTS.StaleEpoch, 503],
    ['Stopped', RESULTS.Stopped, 503],
    ['Moved', RESULTS.Moved, 503],
  ];
  for (const [name, res, expect] of cases) {
    const h = await harness({ accounts: [{ account: 'b1', balanceMicros: ONE_USD }] });
    const idx = h.rt.appends.length;
    h.rt.scriptAppend(res());
    const a = await h.book('b1', `cc1-${name}`, book(0, 60, 10));
    const calls = h.rt.appends.slice(idx);
    if (expect === 'confirmed') {
      assert.equal(a.http, 200, name);
      assert.equal(S(a), 'confirmed', name);
      assert.equal(stable(calls[0]!.call.conditions), stable(calls[1]!.call.conditions), `${name}: retried with the same identities`);
      assert.equal(h.links.calls[0] !== undefined && h.rt.events.indexOf(`commit:${ENTRY.E1}:b1:${(h.links.calls[0].cmd.request.seq)}`) >= 0, true);
    } else {
      assert.equal(a.http, expect, name);
      assert.equal(h.links.calls.length, 0, `${name}: nothing sent`);
      assert.equal(h.replies.length, 0, `${name}: no answer from memory`);
      // The key was not consumed: the client's retry with the same key creates the request.
      const again = await h.book('b1', `cc1-${name}`, book(0, 60, 10));
      assert.equal(S(again), 'confirmed', `${name}: retry with the same key`);
    }
    if (name === 'unknown') assert.ok(h.owner.alerts.some((x) => x.code === 'UNKNOWN_APPEND_RESULT'));
  }
});

test('C01 CC-6: the movement feed replayed twice and out of order gives the same state; the feed position is recorded in the applying F1', async () => {
  const h = await harness({ accounts: [{ account: 'b1', balanceMicros: 0n }] });
  const e1 = movementM1('b1', 1, 400_000n, 400_000n);
  const e2 = movementM1('b1', 2, 600_000n, ONE_USD);
  for (const e of [e2, e1, e2, e1, e1]) await h.rt.deliver(MOVEMENT_FEED_TOPIC, e);
  assert.equal(balanceOf(h.owner.accountState('b1')!.funds), ONE_USD);
  const f1s = entriesOf(h, 'b1').filter((e) => e.entry.kind === ENTRY.F1);
  assert.equal(f1s.length, 2, 'each feed position applied once');
  const seqs = f1s.map((e) => (e.entry.payload as { funds: { input: C05.F1 } }).funds.input.feed[0]!.seq).sort();
  assert.deepEqual(seqs, [1n, 2n]);
});

test('C01 CC-7: every reply and command from memory immediately follows a valid leaseValid; without a lease nothing is sent', async () => {
  const h = await harness({ accounts: [{ account: 'b1', balanceMicros: ONE_USD }] });
  await h.book('b1', 'cc7', book(0, 60, 10));
  assert.ok(h.rt.trace.some((t) => t.t === 'command') && h.rt.trace.some((t) => t.t === 'reply'));
  assert.deepEqual(h.rt.unleasedActions(), []);
  const h2 = await harness({ accounts: [{ account: 'b1', balanceMicros: ONE_USD }] });
  h2.rt.setLease(h2.rt.slotOf(utf8('b1')).slot, false);
  const a = await h2.book('b1', 'cc7', book(0, 60, 10));
  assert.equal(a.http, 503);
  assert.equal(h2.links.calls.length, 0);
  assert.deepEqual(h2.rt.unleasedActions(), []);
});

test('C01 CC-8: the account declaration validates, generates its tables, and matches the RFC-002 §2.2/§2.3 registry', () => {
  const d = accountDeclaration();
  assert.deepEqual(validateDeclaration(d), []);
  const sql = kindMigration(d).statements.join('\n');
  for (const t of ['account_log', 'account_head', 'account_outbox', 'account_request', 'account_decision', 'account_idempotency', 'account_funds']) {
    assert.match(sql, new RegExp(t));
  }
  const kinds = d.entryKinds.map((k) => k.kind).sort((a, b) => a - b);
  assert.deepEqual(kinds, [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111]);
  assert.ok(!kinds.includes(10), 'E10 is retired and its number is not used again');
  for (const p of d.projections) assert.match(p.ddl, /PRIMARY KEY \(account[,)]/, `${p.name} is keyed by the account first`);
  assert.deepEqual(d.streams.map((s) => s.topic), ['account.outcome.v1', 'account.lifecycle.v1', 'account.standing.v1', 'account.usage-applied.v1']);
  assert.equal(d.streams.find((s) => s.name === 'outcome')!.key, 'slot');
  assert.equal(d.streams.find((s) => s.name === 'lifecycle')!.closure, 'resolved');
});

for (const [row, markerAttempt] of [['the recorded attempt', 1], ['another attempt', 2]] as const) {
  test(`C02 consumer test 7 (C02-C 7, first row): a displacement marker with ${row} means no E5; the request is decided against the reduced capacity`, async () => {
    const h = await harness({ accounts: [{ account: 'b1', balanceMicros: ONE_USD }] });
    h.links.afterHold = (cmd) => h.links.displace(cmd.link, cmd.request, markerAttempt);
    const a = await h.book('b1', 'disp', book(0, 60, 10));
    const log = entriesOf(h, 'b1');
    assert.equal(log.filter((e) => e.entry.kind === ENTRY.E5).length, 0, 'no E5');
    assert.equal(log.filter((e) => e.entry.kind === ENTRY.E7).length, 1);
    assert.equal(log.filter((e) => e.entry.kind === ENTRY.E8).length, 1, 'releases durable after the release');
    assert.deepEqual(h.links.calls.map((c) => c.op), ['hold', 'release']);
    assert.equal(S(a), 'rejected');
    assert.equal((a.body as { reason: string }).reason, 'no_fit');
    assert.equal(S(h.status('b1', 'disp')), 'rejected');
  });
}

test('C08 C-01: expired context, tenant ≠ partition, forged key record → no effect; a lower-version key record is ignored; principal fields copied into audit', async () => {
  const h = await harness({ accounts: [{ account: 'b1', balanceMicros: ONE_USD }, { account: 'b2', balanceMicros: ONE_USD }] });
  const now = h.nowMs();
  const n0 = h.rt.appends.length;
  const call = (principal: ReturnType<typeof agentContext>, key: string) => h.owner.book('b1', { principal, key, body: book(0, 60, 10), receivedAtMono: performance.now() });
  assert.equal((await call(agentContext('b1', 'b1-k1', now, { expires_at: BigInt(now - 1) * 1_000n }), 'c1')).http, 401);
  assert.equal((await call(agentContext('b2', 'b2-k1', now), 'c2')).http, 404);
  const record = { key_id: 'b1-k1', identity_slot: 0, epoch: '1', tenant: { kind: 'account' as const, account: 'b2' }, status: 'active' as const,
    limits: { key_spend_limit_micro_usd: null, key_inflight_limit_mbps: null, key_rate_limit_per_s: 50 }, version: 9, committed_at: 0n, probe: false,
    signature: { key_id: 'x', sig: 'AA' } };
  assert.equal((await call(agentContext('b1', 'b1-k1', now, { key_record: record }), 'c3')).http, 401);
  assert.equal((await call(agentContext('b1', 'unknown-key', now), 'c4')).http, 401);
  assert.equal(h.rt.appends.length, n0, 'no effect: nothing appended');
  const lower = { ...record, tenant: { kind: 'account' as const, account: 'b1' }, version: 0 };
  const ctx = agentContext('b1', 'b1-k1', now, { key_record: lower });
  const ok = await call(ctx, 'c5');
  assert.equal(S(ok), 'confirmed', 'a lower-version record is ignored; the applied key governs');
  const e1 = entriesOf(h, 'b1').find((e) => e.entry.kind === ENTRY.E1)!;
  assert.equal(e1.entry.audit.principal.principal_id, ctx.principal_id);
  assert.equal(e1.entry.audit.principal.key_id, 'b1-k1');
  assert.equal(e1.entry.audit.request_id, ctx.request_id);
  assert.equal(e1.entry.audit.received_at, Number(ctx.received_at));
  assert.equal(e1.entry.audit.policy_version, ctx.policy_version);
  assert.deepEqual(e1.entry.audit.iam_position, ctx.iam_position);
});

test('C04 PL-1: E5 emits exactly the outcome event and lifecycle confirmed in its transaction, with contiguous stream_seq; the outcome has its identity and a covering report position', async () => {
  const h = await harness({ accounts: [{ account: 'b1', balanceMicros: ONE_USD }] });
  await h.book('b1', 'pl1-a', book(0, 60, 10));
  await h.book('b1', 'pl1-b', book(0, 60, 10));
  const e5s = entriesOf(h, 'b1').filter((e) => e.entry.kind === ENTRY.E5);
  assert.equal(e5s.length, 2);
  for (const e5 of e5s) {
    assert.deepEqual(e5.entry.emits!.map((x) => x.stream), ['outcome', 'lifecycle']);
    assert.deepEqual(e5.streamSeqs.map((s) => s.stream), ['outcome', 'lifecycle']);
    const lc = e5.entry.emits![1]!.event as Confirmed;
    assert.equal(lc.kind, 'confirmed');
    assert.equal(lc.parts.length, 1);
    assert.equal(lc.decided_ts, e5.ts);
    const oc = e5.entry.emits![0]!.event as OutcomeEvent;
    assert.equal(oc.outcome, 'confirmed');
    assert.equal(oc.entry_seq, e5.seq);
    assert.ok(compareHlc(h.rt.reportPosition(oc.slot)!, e5.ts) >= 0, 'a covering report position');
  }
  const lcSeqs = h.rt.published.filter((p) => p.stream === 'lifecycle').map((p) => p.streamSeq);
  assert.deepEqual(lcSeqs, [1n, 2n]);
  const ocSeqs = h.rt.published.filter((p) => p.stream === 'outcome').map((p) => p.streamSeq);
  assert.deepEqual(ocSeqs, [1n, 2n]);
  assert.ok(h.rt.published.filter((p) => p.stream === 'outcome').every((p) => p.topic === 'account.outcome.v1'));
});

async function waitFor(cond: () => boolean, ms = 2_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------------- Replay helper (C05 P1) ----------------

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? `${x}n` : x instanceof Uint8Array ? Buffer.from(x).toString('hex') : x));
}

/** Re-run the module on the recorded inputs at the recorded positions; compare each recorded verdict and outcome. */
function replayFunds(log: Array<{ seq: bigint; ts: HlcTs; entry: EntryInput }>, account: string, stopAt?: bigint): { verdict?: C05.Verdict } {
  let s = emptyFundsState();
  let lastVerdict: C05.Verdict | undefined;
  for (const e of log) {
    const f = (e.entry.payload as { funds?: { input?: C05.Input; ask?: C05.Ask; verdict?: C05.Verdict; rules: string; outcomes: C05.Outcomes } }).funds;
    if (!f) continue;
    const ctx: C05.Ctx = { pos: { partition: account, sequence: e.seq }, ts: time.toC05(e.ts), rules: f.rules };
    let input: C05.Input;
    if (f.ask && f.verdict) {
      const verdict = fundsModule.admit(s, ctx, f.ask);
      assert.equal(stable(verdict), stable(f.verdict), `verdict at seq ${e.seq}`);
      lastVerdict = verdict;
      input = { kind: 'Intake', request: f.ask.request, ask: f.ask, verdict };
    } else {
      input = f.input!;
    }
    const r = fundsModule.apply(s, ctx, input);
    assert.equal(r.kind, 'Applied');
    if (r.kind !== 'Applied') break;
    assert.equal(stable(r.outcomes), stable(f.outcomes), `outcomes at seq ${e.seq}`);
    s = r.state;
    if (stopAt !== undefined && e.seq >= stopAt) break;
  }
  return lastVerdict ? { verdict: lastVerdict } : {};
}
