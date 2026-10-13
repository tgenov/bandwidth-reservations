/**
 * I1 measurements on the wall clock (run with SEC_MEASURE=1; they take a few seconds and depend on the machine):
 * - DT-23 (X1-S01): unauthenticated answers for malformed, unknown and wrong-secret credentials have the same
 *   latency distribution (two-sample Kolmogorov–Smirnov test, p > 0.05);
 * - I1 exit (8): edge steps 3 to 6 take ≤ 1 ms at p99 on one node.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeDouble } from '@share/owner-runtime/testing';
import { CertStore, mintKey, parseKey } from '@share/iam-lib';
import { DevKeyService } from '@share/key-service';
import { IdentityOwner, declaration, identitySlotOf } from '@share/identity-owner';
import { FIXTURE_WORKLOAD, KeyFixture } from '@share/identity-owner/testing';
import { EdgeGateway, EdgeReplica, wallClock, type EdgeRequest } from '../src/index.ts';

const enabled = process.env['SEC_MEASURE'] === '1';

/** Two-sample KS statistic and its asymptotic p-value. */
export function ksTest(a: number[], b: number[]): { d: number; p: number } {
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  let i = 0; let j = 0; let d = 0;
  while (i < x.length && j < y.length) {
    const v = Math.min(x[i] ?? Infinity, y[j] ?? Infinity);
    while (i < x.length && (x[i] ?? Infinity) <= v) i++;
    while (j < y.length && (y[j] ?? Infinity) <= v) j++;
    d = Math.max(d, Math.abs(i / x.length - j / y.length));
  }
  const n = (x.length * y.length) / (x.length + y.length);
  const lambda = (Math.sqrt(n) + 0.12 + 0.11 / Math.sqrt(n)) * d;
  let p = 0;
  for (let k = 1; k <= 100; k++) p += 2 * (-1) ** (k - 1) * Math.exp(-2 * k * k * lambda * lambda);
  return { d, p: Math.min(1, Math.max(0, p)) };
}

async function setup(measure?: bigint[]) {
  const now = (): bigint => wallClock.nowMicros();
  const ks = new DevKeyService(now);
  const rt = new RuntimeDouble({ declaration, startMs: Number(now() / 1000n) });
  const owner = new IdentityOwner({ runtime: rt, certifier: ks, sleep: async () => {} });
  rt.attach(owner);
  const issued = await new KeyFixture(owner).issueAgentKey(FIXTURE_WORKLOAD, 'b1');
  assert.ok(issued.ok && 'token' in issued);
  const certs = new CertStore(ks.rootPublicKey);
  const replica = new EdgeReplica(certs);
  const sync = (): void => {
    for (const m of ks.read(certs.head)) certs.apply(m);
    const slot = identitySlotOf({ kind: 'account', account: 'b1' });
    replica.apply(slot, owner.edgeStream(slot, replica.position(slot)), now());
  };
  sync();
  const policy = owner.getPolicy();
  assert.ok(!('kind' in policy));
  const gateway = new EdgeGateway({ replica, policy, router: rt, clock: wallClock, workload: 'edge-measure',
    forwarder: { forward: async () => ({ kind: 'ok', body: {} }) }, ...(measure ? { measure } : {}) });
  return { gateway, token: issued.token, keyId: issued.key_id, sync };
}

function wrongSecret(keyId: string): string {
  for (;;) {
    const secret = /^shk_[0-9a-f]{32}_(.{43}).$/.exec(mintKey().token)?.[1] ?? '';
    for (const c of '0123456789abcdefghjkmnpqrstvwxyz') if (parseKey(`shk_${keyId}_${secret}${c}`)) return `shk_${keyId}_${secret}${c}`;
  }
}

test('DT-23 (X1-S01): malformed, unknown and wrong-secret answers have the same latency distribution', { skip: !enabled }, async () => {
  const { gateway, keyId, sync } = await setup();
  const causes: Record<string, string> = {
    malformed: 'Bearer shk_not-a-key', unknown: `Bearer ${mintKey().token}`, wrong_secret: `Bearer ${wrongSecret(keyId)}`,
  };
  const samples: Record<string, number[]> = { malformed: [], unknown: [], wrong_secret: [] };
  const names = Object.keys(causes);
  for (let i = 0; i < 300; i++) {
    if (i % 100 === 0) sync();
    for (const name of names.sort(() => Math.random() - 0.5)) {
      const req: EdgeRequest = { authorization: causes[name] ?? '', operation: 'book' };
      const t0 = process.hrtime.bigint();
      const r = await gateway.handle(req);
      const dt = Number(process.hrtime.bigint() - t0) / 1e3;
      assert.equal(r.status, 401);
      assert.ok(dt >= 5_000 - 1, `answer not before the 5 ms floor (${dt} µs)`);
      samples[name]?.push(dt);
    }
  }
  const pairs: Array<[string, string]> = [['malformed', 'unknown'], ['unknown', 'wrong_secret'], ['malformed', 'wrong_secret']];
  for (const [a, b] of pairs) {
    const r = ksTest(samples[a] ?? [], samples[b] ?? []);
    console.log(`DT-23 ${a} vs ${b}: D=${r.d.toFixed(4)} p=${r.p.toFixed(3)}`);
    assert.ok(r.p > 0.05, `${a} vs ${b}: p = ${r.p}`);
  }
});

test('measurement: I1 exit (8): edge steps 3 to 6 take ≤ 1 ms at p99 on one node', { skip: !enabled }, async () => {
  const measure: bigint[] = [];
  const { gateway, token, sync } = await setup(measure);
  // 2,000 requests/s for 5 s: paced in batches of 200 every 100 ms.
  for (let batch = 0; batch < 50; batch++) {
    if (batch % 10 === 0) sync();
    const start = Date.now();
    await Promise.all(Array.from({ length: 200 }, (_, i) =>
      gateway.handle({ authorization: `Bearer ${token}`, operation: 'book', idempotencyKey: `m-${batch}-${i}` })));
    const wait = 100 - (Date.now() - start);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  const sorted = measure.map(Number).sort((a, b) => a - b);
  const p99 = (sorted[Math.floor(sorted.length * 0.99)] ?? 0) / 1e6;
  const p50 = (sorted[Math.floor(sorted.length * 0.5)] ?? 0) / 1e6;
  console.log(`edge steps 3-6: n=${sorted.length} p50=${p50.toFixed(3)} ms p99=${p99.toFixed(3)} ms`);
  assert.ok(p99 <= 1, `p99 ${p99} ms`);
});
