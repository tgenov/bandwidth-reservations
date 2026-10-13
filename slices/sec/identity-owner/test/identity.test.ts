/** Identity owner kind, I1: C01 CC-1 and CC-8 for the identity kind, the push (P-02 part), the edge stream, the fixture. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hex, validateDeclaration, type AppendResult } from '@share/owner-runtime';
import { RESULTS, RuntimeDouble } from '@share/owner-runtime/testing';
import { kindMigration } from '@share/owner-migrate';
import { CertStore, DOMAINS, hlcToMicros, mintKey, tenantPartition, without, type IdentityStatusEvent } from '@share/iam-lib';
import { DevKeyService, type CertifyRequest, type KeyCertifier } from '@share/key-service';
import { IdentityOwner, STATUS_TOPIC, declaration, identitySlotOf } from '../src/index.ts';
import { FIXTURE_WORKLOAD, KeyFixture } from '../src/testing.ts';

const tenant = { kind: 'account' as const, account: 'b1' };
const actor = { kind: 'onboarding' as const };

const START_MS = 1_700_000_000_000;

/**
 * One injected clock for every party: the runtime double's virtual clock. The key service, the commit timestamps
 * and the verifier's `now` all read it, so no assertion depends on the real wall clock.
 * `certifyDelayMs` models time passing while the key service certifies a key (key generation, the RPC).
 */
function setup(opts: { certifyDelayMs?: number } = {}) {
  const rt = new RuntimeDouble({ declaration, startMs: START_MS });
  const now = (): bigint => hlcToMicros(rt.now().ts);
  const ks = new DevKeyService(now);
  const delay = opts.certifyDelayMs ?? 0;
  const certifier: KeyCertifier = { certify: (req: CertifyRequest) => { rt.advance(delay); return ks.certify(req); } };
  const alerts: string[] = [];
  const owner = new IdentityOwner({ runtime: rt, certifier, sleep: async () => {}, alert: (m) => alerts.push(m) });
  rt.attach(owner);
  return { rt, ks, owner, alerts, now };
}

/** mulberry32: a seeded generator, so a failing case is replayed from its printed seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('C01 CC-8: the identity declaration validates, generates its tables and matches RFC-005 §3.1 / C08 §B', () => {
  assert.deepEqual(validateDeclaration(declaration), []);
  const sql = kindMigration(declaration).statements.join('\n');
  for (const t of ['iam_log', 'iam_head', 'iam_outbox', 'iam_key']) assert.match(sql, new RegExp(t));
  assert.equal(declaration.kind, 'iam');
  assert.ok(declaration.entryKinds.every((e) => e.retention === '7y'), 'key changes are kept 7 years (POL-19)');
  const status = declaration.streams.find((s) => s.name === 'status');
  assert.equal(status?.topic, 'iam.status.v1');
  assert.equal(status?.closure, 'resolved', 'markers on iam.status.v1.closure (C01 §3.6, plan CI5-5)');
  assert.equal(status?.key, 'partition', 'keyed by account (the identity partition)');
});

test('C01 CC-1: every AppendResult takes the §3.2 action; nothing is acknowledged before Committed', async (t) => {
  const retried: Array<[string, AppendResult]> = [
    ['Retry', RESULTS.Retry()], ['Ambiguous', RESULTS.Ambiguous()], ['Moving', RESULTS.Moving()],
    ['Overloaded', RESULTS.Overloaded(1)], ['unknown', RESULTS.Unknown()],
  ];
  for (const [name, result] of retried) {
    await t.test(`${name} → retried with the same identity, then Committed`, async () => {
      const { rt, owner, alerts } = setup();
      const k = mintKey();
      rt.scriptAppend(result);
      const a = await owner.issueKey({ tenant, key_id: k.key_id, verifier: k.verifier, actor, caller: 'test' });
      assert.equal(a.ok, true);
      assert.equal(rt.appends.length, 2);
      assert.equal(rt.appends[0]?.call, rt.appends[1]?.call, 'the same call (same identity) is sent again');
      assert.equal(rt.log(tenantPartition(tenant)).length, 1);
      if (name === 'unknown') assert.equal(alerts.length, 1, 'an unknown result is alerted (C01 §8)');
    });
  }
  const terminal: Array<[string, AppendResult, string]> = [
    ['Stopped', RESULTS.Stopped(), 'temporarily_unavailable'], ['StaleEpoch', RESULTS.StaleEpoch(), 'not_owner'],
    ['Moved', RESULTS.Moved(), 'not_owner'], ['ConditionFailed', RESULTS.ConditionFailed(), 'retry_later'],
  ];
  for (const [name, result, reason] of terminal) {
    await t.test(`${name} → ${reason}, no acknowledgement, no edge record`, async () => {
      const { rt, owner } = setup();
      const k = mintKey();
      rt.scriptAppend(result);
      const a = await owner.issueKey({ tenant, key_id: k.key_id, verifier: k.verifier, actor, caller: 'test' });
      assert.deepEqual(a, { ok: false, reason });
      const slot = identitySlotOf(tenant);
      assert.equal(owner.edgeStream(slot, '0').filter((m) => 'record' in m).length, 0);
    });
  }
  await t.test('a retried command after a commit is idempotent (the key row exists)', async () => {
    const { rt, owner } = setup();
    const k = mintKey();
    const cmd = { tenant, key_id: k.key_id, verifier: k.verifier, actor, caller: 'test' };
    assert.equal((await owner.issueKey(cmd)).ok, true);
    assert.deepEqual(await owner.issueKey(cmd), { ok: true, key_id: k.key_id, version: 1, changed: false });
    assert.equal(rt.log(tenantPartition(tenant)).length, 1);
  });
});

test('C08 P-02 (I1 part): every key commit yields exactly one IdentityStatusEvent with its source', async () => {
  const { rt, owner } = setup();
  const k = mintKey();
  await owner.issueKey({ tenant, key_id: k.key_id, verifier: k.verifier, actor, caller: 'test' });
  await owner.revokeKey({ tenant, key_id: k.key_id, actor, caller: 'test' });
  assert.deepEqual(await owner.revokeKey({ tenant, key_id: k.key_id, actor, caller: 'test' }),
    { ok: true, key_id: k.key_id, version: 2, changed: false }, 'revoked is terminal: no second event');
  const events = rt.published.filter((p) => p.topic === STATUS_TOPIC).map((p) => p.event as IdentityStatusEvent);
  assert.equal(events.length, 2);
  const log = rt.log(tenantPartition(tenant));
  events.forEach((e, i) => {
    assert.equal(e.account, 'b1');
    assert.equal(e.source.identity_partition, hex(tenantPartition(tenant)));
    assert.equal(e.source.seq, log[i]?.seq.toString(), 'source.seq is the log sequence');
  });
  assert.deepEqual(events.map((e) => [e.body.kind, 'version' in e.body ? e.body.version : 0]), [['key_issued', 1], ['key_revoked', 2]]);
  assert.ok(!JSON.stringify(rt.published, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)).includes(k.token),
    'no secret is published');
});

test('C08 §C: edge stream records and heartbeats are identity-signed; no heartbeat without a valid lease', async () => {
  const { rt, ks, owner, now: clock } = setup();
  const certs = new CertStore(ks.rootPublicKey);
  const k = mintKey();
  await owner.issueKey({ tenant, key_id: k.key_id, verifier: k.verifier, actor, caller: 'test' });
  for (const m of ks.read('0')) certs.apply(m);
  const slot = identitySlotOf(tenant);
  const msgs = owner.edgeStream(slot, '0');
  assert.equal(msgs.length, 2);
  const [rec, hb] = msgs;
  assert.ok(rec && 'record' in rec && hb && 'heartbeat' in hb);
  const now = clock();
  const req = { purpose: 'identity_record' as const, owner_kind: 'identity', slot, epoch: rec.record.epoch };
  assert.ok(certs.verify(DOMAINS.edgeRecord, without(rec.record, 'signature'), rec.record.signature, { ...req, validAt: { committed_at: rec.record.committed_at } }, now).ok);
  assert.ok(rec.key_record && certs.verify(DOMAINS.keyRecord, without(rec.key_record, 'signature'), rec.key_record.signature, { ...req, validAt: { committed_at: rec.key_record.committed_at } }, now).ok);
  assert.ok(certs.verify(DOMAINS.edgeHeartbeat, without(hb.heartbeat, 'signature'), hb.heartbeat.signature, { ...req, validAt: 'now' }, now).ok);
  assert.equal(hb.heartbeat.head, rec.record.position, 'the heartbeat follows every record up to its head');
  rt.setLease(slot, false);
  assert.deepEqual(owner.edgeStream(slot, '0'), [], 'a holder without a valid lease sends nothing');
  rt.setLease(slot, true);
  const policy = owner.getPolicy();
  assert.ok(!('kind' in policy) && policy.policy_version === 1);
});

test('C08 §C / V56-3 regression: a record verifies under its cert at committed_at even when certification takes time', async () => {
  // Defect: the record-signing key was certified lazily AFTER the commit, so cert.not_before > committed_at and
  // every receiver refused the record as outside_validity. Each seed draws how long certification takes.
  for (let seed = 1; seed <= 200; seed++) {
    const r = rng(seed);
    const certifyDelayMs = Math.floor(r() * 50) + 1;
    const { ks, owner, now } = setup({ certifyDelayMs });
    const k = mintKey();
    assert.equal((await owner.issueKey({ tenant, key_id: k.key_id, verifier: k.verifier, actor, caller: 'test' })).ok, true);
    const certs = new CertStore(ks.rootPublicKey);
    for (const m of ks.read('0')) certs.apply(m);
    const slot = identitySlotOf(tenant);
    const [rec] = owner.edgeStream(slot, '0');
    assert.ok(rec && 'record' in rec && rec.key_record);
    const req = { purpose: 'identity_record' as const, owner_kind: 'identity', slot, epoch: rec.record.epoch };
    const v = certs.verify(DOMAINS.edgeRecord, without(rec.record, 'signature'), rec.record.signature,
      { ...req, validAt: { committed_at: rec.record.committed_at } }, now());
    const kv = certs.verify(DOMAINS.keyRecord, without(rec.key_record, 'signature'), rec.key_record.signature,
      { ...req, validAt: { committed_at: rec.key_record.committed_at } }, now());
    const why = () => `seed=${seed} certifyDelayMs=${certifyDelayMs} committed_at=${rec.record.committed_at} edge=${JSON.stringify(v.ok ? 'ok' : v)} key=${JSON.stringify(kv.ok ? 'ok' : kv)}`;
    assert.ok(v.ok && kv.ok, why());
    assert.ok(v.cert.not_before <= rec.record.committed_at, why());
  }
});

test('should accept the fixture only when it comes from the test workload identity', async () => {
  const { owner, rt } = setup();
  const f = new KeyFixture(owner);
  assert.deepEqual(await f.issueAgentKey('spiffe://share/edge/node-1', 'b1'), { ok: false, reason: 'caller_not_allowed' });
  assert.equal(rt.appends.length, 0);
  const a = await f.issueAgentKey(FIXTURE_WORKLOAD, 'b1');
  assert.equal(a.ok, true);
});

test('should not reach the fixture module from the production entry when the fixture lint runs', () => {
  const dir = fileURLToPath(new URL('../src/', import.meta.url));
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && n !== 'fixture.ts' && n !== 'testing.ts')) {
    const text = readFileSync(dir + f, 'utf8');
    assert.ok(!/from '\.\/(fixture|testing)\.ts'/.test(text), `${f} imports the fixture`);
  }
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { exports: Record<string, string> };
  assert.equal(pkg.exports['.'], './src/index.ts');
});
