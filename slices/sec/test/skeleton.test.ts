/**
 * S-SEC I1 walking skeleton, end to end on the C01 runtime double and a simulated clock:
 * X1-S01, X1-S05, X1-S07, the revocation bound (C08 §C, P-03 for keys) and exit criterion (6).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hlcToWallMs } from '@share/owner-runtime';
import { feedEvent } from '@share/owner-runtime/testing';
import { CONTEXT_METADATA_KEY, CONTEXT_TTL_MICROS, mintKey, parseKey } from '@share/iam-lib';
import { UNAUTH_FLOOR_MICROS, type EdgeOperation, type EdgeRequest } from '@share/edge-auth';
import { partitionOf } from '@share/sec-test-owner';
import { EDGE_WORKLOAD, PUSH_PARTITIONS, bearer, skeleton, type Skeleton } from './harness.ts';

async function ready(...accounts: string[]): Promise<Skeleton> {
  const s = await skeleton();
  for (const a of accounts) s.watch(a);
  await s.tick();
  return s;
}

/** Capture the context the edge forwards, to replay it to the owner in owner-side checks. */
function captureContexts(s: Skeleton): Array<{ md: Record<string, Uint8Array>; account: string }> {
  const seen: Array<{ md: Record<string, Uint8Array>; account: string }> = [];
  const inner = s.owner.command.bind(s.owner);
  s.owner.command = async (peer, md, cmd) => { seen.push({ md, account: cmd.account }); return inner(peer, md, cmd); };
  return seen;
}

test('X1-S01: an unauthenticated request changes nothing and reveals nothing', async (t) => {
  const s = await ready('b1');
  const live = await s.issue('b1');
  const revoked = await s.issue('b1');
  await s.tick();
  await s.revoke('b1', revoked.key_id);
  await s.tick();
  const other = mintKey('shk');
  const causes: Record<string, string | undefined> = {
    'no credential': undefined,
    'malformed': 'Bearer not-a-key',
    'bad check digit': bearer(live.token.slice(0, -1) + (live.token.endsWith('0') ? '1' : '0')),
    'unknown key': bearer(other.token),
    'wrong secret': bearer(wrongSecretToken(live.key_id)),
    'revoked key': bearer(revoked.token),
    'supplier prefix': bearer(live.token.replace(/^shk_/, 'ssk_')),
  };
  const rows: Array<[string, EdgeOperation, string]> = [
    ['book a route', 'book', 'the submission is not accepted as unauthenticated'],
    ["ask for a booking request's status", 'status', 'the submission is not accepted as unauthenticated'],
    ['cancel a reservation', 'cancel', 'the request is refused as unauthenticated'],
    ['ask for a balance', 'balance', 'the request is refused as unauthenticated'],
    ['ask for a statement', 'statement', 'the request is refused as unauthenticated'],
    ['issue an agent key', 'issue_key', 'the request is refused as unauthenticated'],
  ];
  const appendsBefore = s.ownerRt.appends.length;
  const auditBefore = s.auditRt.appends.length;
  const forwardedBefore = s.forwarded;
  let reference: { headers: Record<string, string>; body: string } | undefined;
  for (const [row, op] of rows) {
    await t.test(`X1-S01 row: ${row}`, async () => {
      for (const [cause, authorization] of Object.entries(causes)) {
        const req: EdgeRequest = { operation: op, account: 'b1', idempotencyKey: `k-${op}`, ...(authorization ? { authorization } : {}) };
        const received = BigInt(s.nowMs()) * 1000n;
        const r = await s.gateway.handle(req);
        assert.equal(r.status, 401, `${row} / ${cause}`);
        assert.equal(r.body, '{"error":"unauthenticated"}', cause);
        reference ??= { headers: r.headers, body: r.body };
        assert.deepEqual(r.headers, reference.headers, `identical headers (${cause})`);
        assert.equal(r.forwarded, false, `not forwarded (${cause})`);
        // DT-23 on the simulated clock: every cause answers exactly at the floor, not earlier.
        assert.equal(r.answeredAt - received, UNAUTH_FLOOR_MICROS, `floor (${cause})`);
      }
    });
  }
  assert.equal(s.ownerRt.appends.length, appendsBefore, 'nothing changes at the owner');
  assert.equal(s.auditRt.appends.length, auditBefore, 'nothing recorded about any account');
  assert.equal(s.forwarded, forwardedBefore, 'nothing forwarded');
  const logText = JSON.stringify(s.gateway.logs);
  assert.ok(!logText.includes('k-book') && !logText.includes(live.token) && !logText.includes(live.key_id),
    'edge logs hold no idempotency key, no credential');
});

function wrongSecretToken(keyId: string): string {
  // A well-formed token for a known key id with another secret (valid check digit).
  for (;;) {
    const m = mintKey('shk');
    const secret = /^shk_[0-9a-f]{32}_(.{43}).$/.exec(m.token)?.[1];
    if (!secret) continue;
    const body = `shk_${keyId}_${secret}`;
    // Find the valid check digit with the library's parser.
    for (const c of '0123456789abcdefghjkmnpqrstvwxyz') {
      const candidate = body + c;
      if (parseKey(candidate)) return candidate;
    }
  }
}

test('X1-S05: an agent key acts only for the account that issued it', async () => {
  const s = await ready('b1', 'b2');
  const k = await s.issue('b1');
  await s.issue('b2');
  await s.tick();
  const b2 = partitionOf('b2');
  const b2Before = s.ownerRt.log(b2).length;
  const fwd = s.forwarded;

  const book = await s.gateway.handle({ authorization: bearer(k.token), operation: 'book', account: 'b2', idempotencyKey: 'x1' });
  assert.equal(book.status, 404, 'booking submission for b2 not accepted');
  assert.equal(book.body, '{"error":"not_found"}');
  const read = await s.gateway.handle({ authorization: bearer(k.token), operation: 'status', account: 'b2' });
  assert.equal(read.status, 404, 'read for b2 refused with the "not found" answer');
  assert.equal(s.forwarded, fwd, 'nothing forwarded');
  assert.equal(s.ownerRt.log(b2).length, b2Before, 'nothing changes for b2');

  const own = await s.gateway.handle({ authorization: bearer(k.token), operation: 'book', account: 'b1', idempotencyKey: 'x2' });
  assert.equal(own.status, 200, 'the same key books for its own account');
});

test('X1-S05 / DT-4: the test owner refuses a context for another tenant and a context from a non-edge peer', async () => {
  const s = await ready('b1', 'b2');
  const seen = captureContexts(s);
  const k = await s.issue('b1');
  await s.tick();
  assert.equal((await s.gateway.handle({ authorization: bearer(k.token), operation: 'book', idempotencyKey: 'a1' })).status, 200);
  const md = seen[0]?.md;
  assert.ok(md);
  const b2 = partitionOf('b2');
  const before = s.ownerRt.log(b2).length;
  // A context naming tenant b1 sent to b2's partition.
  const a = await s.owner.command(EDGE_WORKLOAD, md as never, { op: 'book', account: 'b2', idempotencyKey: 'a2' });
  assert.deepEqual(a, { kind: 'not_found' });
  // The same context from a peer that is not an edge workload: refused before any effect, and recorded.
  const auditBefore = s.auditRt.appends.length;
  const p = await s.owner.command('spiffe://share/other/service', md as never, { op: 'book', account: 'b1', idempotencyKey: 'a3' });
  assert.equal(p.kind, 'unauthenticated');
  assert.equal(s.ownerRt.log(b2).length, before);
  assert.equal(s.ownerRt.log(partitionOf('b1')).filter((e) => (e.entry.payload as { idempotency_key?: string }).idempotency_key === 'a3').length, 0);
  assert.equal(s.auditRt.appends.length, auditBefore + 1, 'the refusal is recorded by audit_append');
});

test('X1-S07: an operation by an agent key records the key, as well as the account', async () => {
  const s = await ready('b1');
  const k = await s.issue('b1');
  await s.tick();
  for (const op of ['book', 'change', 'cancel'] as const) {
    const r = await s.gateway.handle({ authorization: bearer(k.token), operation: op, idempotencyKey: `s07-${op}` });
    assert.equal(r.status, 200, op);
  }
  const entries = s.ownerRt.log(partitionOf('b1')).filter((e) => e.entry.kind === 1);
  assert.equal(entries.length, 3);
  for (const e of entries) {
    const a = e.entry.audit;
    assert.equal(a.principal.key_id, k.key_id, 'the change records the key');
    assert.equal(a.principal.tenant, 'account:b1', 'and the account');
    assert.equal(a.principal.kind, 'agent_key');
    assert.equal(a.principal.edge_workload, EDGE_WORKLOAD);
    assert.equal(a.policy_version, 1);
    assert.ok(a.request_id && a.received_at && a.iam_position, 'C08 §A outcome fields copied');
  }
});

test('X1-S07 / C08 C-01, DT-25: invalid contexts change nothing at the test owner', async () => {
  const s = await ready('b1');
  const seen = captureContexts(s);
  // The push does not reach the owner yet: the key is known only by the context's key record.
  s.cut.relay = true;
  const k = await s.issue('b1');
  await s.tick();
  assert.equal((await s.gateway.handle({ authorization: bearer(k.token), operation: 'book', idempotencyKey: 'c0' })).status, 200,
    'a valid key record admits the request (its limits are provisional, for this request only)');
  const raw = seen[0]?.md[CONTEXT_METADATA_KEY];
  assert.ok(raw);
  const ctx = JSON.parse(Buffer.from(raw).toString('utf8')) as Record<string, unknown>;
  const b1 = partitionOf('b1');
  const n = (): number => s.ownerRt.log(b1).length;
  const send = (c: Record<string, unknown>, key: string) =>
    s.owner.command(EDGE_WORKLOAD, { [CONTEXT_METADATA_KEY]: new Uint8Array(Buffer.from(JSON.stringify(c))) }, { op: 'book', account: 'b1', idempotencyKey: key });
  const before = n();

  // Expired: now > expires_at.
  await s.tick(Number(CONTEXT_TTL_MICROS / 1000n) + 1);
  assert.equal((await send(ctx, 'c1')).kind, 'unauthenticated', 'expired');
  const now = BigInt(s.nowMs()) * 1000n;
  const fresh: Record<string, unknown> = { ...ctx, received_at: String(now), expires_at: String(now + CONTEXT_TTL_MICROS) };
  // Forged key record: a changed limit breaks the identity signature.
  const kr = fresh['key_record'] as Record<string, unknown>;
  const forged = { ...fresh, key_record: { ...kr, limits: { ...(kr['limits'] as object), key_rate_limit_per_s: 5000 } } };
  assert.equal((await send(forged, 'c2')).kind, 'unauthenticated', 'forged key record');
  // A key record naming another tenant than the partition's.
  const otherRecord = { ...fresh, key_record: { ...kr, tenant: { kind: 'account', account: 'b9' } } };
  assert.equal((await send(otherRecord, 'c3')).kind, 'unauthenticated', 'key record of another tenant');
  // A context tenant other than the partition's.
  assert.equal((await send({ ...fresh, tenant: { kind: 'account', account: 'b9' } }, 'c4')).kind, 'not_found', 'tenant not the partition');
  assert.equal(n(), before, 'no effect');
  assert.equal((await send(fresh, 'c5')).kind, 'ok', 'the genuine record, fresh');

  // DT-25: once the push applies the key, a forged record changes nothing in the applied key state.
  s.cut.relay = false;
  await s.tick();
  const applied = s.owner.appliedKey('b1', k.key_id);
  assert.equal(applied?.status, 'active');
  await send({ ...forged, received_at: String(BigInt(s.nowMs()) * 1000n), expires_at: String(BigInt(s.nowMs()) * 1000n + CONTEXT_TTL_MICROS) }, 'c6');
  assert.deepEqual(s.owner.appliedKey('b1', k.key_id), applied, 'applied key state unchanged');
  assert.equal(applied?.limits?.key_rate_limit_per_s, 50);
});

test('revocation: after the push applies, the edge refuses the revoked key within C08 bounds (simulated clock)', async (t) => {
  await t.test('stream live: the edge refuses at the next stream message; the owner refuses after the push applies', async () => {
    const s = await ready('b1');
    const seen = captureContexts(s);
    const k = await s.issue('b1');
    await s.tick();
    assert.equal((await s.gateway.handle({ authorization: bearer(k.token), operation: 'book', idempotencyKey: 'r0' })).status, 200);
    const t0 = s.nowMs();
    await s.revoke('b1', k.key_id);
    await s.tick();
    assert.equal(s.owner.appliedKey('b1', k.key_id)?.status, 'revoked', 'the push applied key_revoked');
    const r = await s.gateway.handle({ authorization: bearer(k.token), operation: 'book', idempotencyKey: 'r1' });
    assert.equal(r.status, 401);
    assert.ok(s.nowMs() - t0 <= 31_000, 'within 31 s of the revocation');
    assert.ok(s.replica.closed.includes(k.key_id), 'the edge closes connections of the revoked key');
    // A context that still carries the old active key record is ignored at the owner (C08 §A).
    const old = seen[0]?.md;
    assert.ok(old);
    const replay = JSON.parse(Buffer.from(old[CONTEXT_METADATA_KEY] ?? new Uint8Array()).toString()) as Record<string, unknown>;
    const now = BigInt(s.nowMs()) * 1000n;
    const fresh = { ...replay, received_at: String(now), expires_at: String(now + CONTEXT_TTL_MICROS) };
    const a = await s.owner.command(EDGE_WORKLOAD, { [CONTEXT_METADATA_KEY]: new Uint8Array(Buffer.from(JSON.stringify(fresh))) },
      { op: 'book', account: 'b1', idempotencyKey: 'r2' });
    assert.deepEqual(a, { kind: 'unauthenticated' });
  });

  await t.test('edge stream cut just before the revocation at t0: the owner refuses after the push, every edge refuses from t0 + 31 s', async () => {
    const s = await ready('b1');
    const k = await s.issue('b1');
    await s.tick();
    s.cut.edgeStream = true;
    const t0 = s.nowMs();
    await s.revoke('b1', k.key_id);
    await s.tick(); // the push applies at the owner (relay live)
    assert.equal(s.owner.appliedKey('b1', k.key_id)?.status, 'revoked');
    // The edge replica is still within its staleness bound and forwards; the owner refuses the key.
    const mid = await s.gateway.handle({ authorization: bearer(k.token), operation: 'book', idempotencyKey: 'm1' });
    assert.equal(mid.forwarded, true);
    assert.equal(mid.status, 401, 'after the push applies, the request is refused as unauthenticated');
    const b1Log = s.ownerRt.log(partitionOf('b1')).filter((e) => e.entry.kind === 1).length;
    assert.equal(b1Log, 0, 'nothing changes');
    // From t0 + 31 s the edge refuses the credential itself (no heartbeat since the cut).
    while (s.nowMs() < t0 + 31_000) await s.tick();
    const late = await s.gateway.handle({ authorization: bearer(k.token), operation: 'book', idempotencyKey: 'm2' });
    assert.equal(late.forwarded, false);
    assert.notEqual(late.status, 200);
    assert.equal(late.status, 503, 'stale replica: "temporarily unavailable", never "authenticated" (RFC-005 §2.3)');
  });
});

test('I1 exit (6): a fixture key issue reaches the test owner within 2 s; resolved markers every 1 s with no traffic', async () => {
  const s = await ready('b1');
  const t0 = s.nowMs();
  const k = await s.issue('b1');
  let reached: number | undefined;
  for (let i = 0; i < 3 && reached === undefined; i++) {
    await s.tick();
    const e = s.owner.appliedEvents.find((x) => x.event.body.kind === 'key_issued' && 'key_id' in x.event.body && x.event.body.key_id === k.key_id);
    if (e) reached = hlcToWallMs(e.appliedAt);
  }
  assert.ok(reached !== undefined && reached - t0 <= 2_000, 'applied within 2 s');
  // Duplicate delivery of the same event changes nothing (exactly-once effect by source).
  const pub = s.iamRt.published.find((p) => (p.event as { body: { key_id?: string } }).body.key_id === k.key_id);
  assert.ok(pub);
  const appendsBefore = s.ownerRt.log(partitionOf('b1')).length;
  await s.ownerRt.deliver('iam.status.v1', feedEvent({ partition: pub.partition, stream: pub.stream, streamSeq: pub.streamSeq, event: pub.event }));
  assert.equal(s.ownerRt.log(partitionOf('b1')).length, appendsBefore, 'a replayed event is a no-op');

  const before = s.owner.resolvedLog.length;
  const quietFrom = s.nowMs();
  for (let i = 0; i < 5; i++) await s.tick();
  const markers = s.owner.resolvedLog.slice(before);
  for (let p = 0; p < PUSH_PARTITIONS; p++) {
    const mine = markers.filter((m) => m.partition === p).map((m) => hlcToWallMs(m.R));
    assert.equal(mine.length, 5, `partition ${p}: one marker per second`);
    for (let i = 1; i < mine.length; i++) assert.equal((mine[i] ?? 0) - (mine[i - 1] ?? 0), 1_000);
    assert.ok((mine[0] ?? 0) - quietFrom <= 1_000);
  }
});
