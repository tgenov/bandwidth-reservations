/**
 * C10 over HTTP (AM-I1): `book` and `status` through the edge double to the account owner on the
 * runtime double, with the C02 link double. CT-P01 subset: the 200 ms acknowledgement rule.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { NINE_AM_MS, PRODUCT, harness, windowAt } from '@share/account-owner/testing';
import { StaticEdgeIdentity, createBookingApi } from '../src/index.ts';

const ACCOUNTS = ['b1', 'b2', 'b3', 'b4'];

async function api(opts: { balance?: bigint; links?: Array<{ link: string; capacityMbps: number }> } = {}) {
  const h = await harness({
    accounts: ACCOUNTS.map((account) => ({ account, balanceMicros: opts.balance ?? 1_000_000_000n })),
    links: opts.links ?? [{ link: 'L1', capacityMbps: 1_000_000 }],
  });
  const tokens: Record<string, { account: string; principalId: string; kind: 'agent_key'; keyId: string }> = {};
  for (const a of ACCOUNTS) tokens[`shk_${a}-k1_secret`] = { account: a, principalId: `p-${a}-k1`, kind: 'agent_key', keyId: `${a}-k1` };
  tokens['shk_b1-k2_secret'] = { account: 'b1', principalId: 'p-b1-k2', kind: 'agent_key', keyId: 'b1-k1' };
  // The owner and the edge read the same virtual clock as the runtime double.
  const server = createBookingApi({ owner: h.owner, reader: h.reader, identity: new StaticEdgeIdentity(tokens), wallMs: () => h.nowMs() });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  after(() => new Promise<void>((r) => server.close(() => r())));
  const post = (token: string | undefined, key: string | undefined, body: unknown) => fetch(`${base}/v1/bookings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key !== undefined ? { 'idempotency-key': key } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const get = (token: string, key: string) => fetch(`${base}/v1/requests/${encodeURIComponent(key)}`, { headers: { authorization: `Bearer ${token}` } });
  return { h, post, get, server };
}

const body = (rate = 1, startMin = 0, endMin: number | null = 60) =>
  ({ legs: ['L1'], window: windowAt(NINE_AM_MS, startMin, endMin), rate_mbps: rate, product_id: PRODUCT });

test('C10 ack rule (CT-P01 subset, P2-S07, X2-S15): a single-link booking with no capacity in flight answers 200 confirmed within 200 ms at p99', async (t) => {
  const { post } = await api();
  const n = Number(process.env['ACK_CALLS'] ?? 2_000);
  const lat: number[] = [];
  let confirmed = 0;
  for (let i = 0; i < n; i++) {
    const account = ACCOUNTS[i % ACCOUNTS.length]!;
    const t0 = performance.now();
    const r = await post(`shk_${account}-k1_secret`, `ack-${i}`, body());
    const j = (await r.json()) as { state: string };
    lat.push(performance.now() - t0);
    if (r.status === 200 && j.state === 'confirmed') confirmed += 1;
  }
  lat.sort((a, b) => a - b);
  const p99 = lat[Math.ceil(0.99 * n) - 1]!;
  t.diagnostic(`n=${n} confirmed=${confirmed} p50=${lat[Math.floor(n / 2)]!.toFixed(2)} ms p99=${p99.toFixed(2)} ms max=${lat[n - 1]!.toFixed(2)} ms`);
  assert.ok(confirmed >= Math.ceil(0.99 * n), `final 200 confirmed answers: ${confirmed} of ${n} (at p99)`);
  assert.ok(p99 < 200, `p99 ${p99.toFixed(1)} ms`);
});

test('C10 book over HTTP: the same Idempotency-Key gives the same answer; another body or another principal gives 409; status reads agree', async () => {
  const { post, get } = await api();
  const t = 'shk_b1-k1_secret';
  const r1 = await post(t, 'idem-1', body(5));
  const a1 = await r1.json();
  const r2 = await post(t, 'idem-1', { ...body(5), deadline_ms: 20_000 });
  assert.equal(r1.status, 200);
  assert.deepEqual(await r2.json(), a1);
  assert.equal(r2.status, 200);
  const r3 = await post(t, 'idem-1', body(6));
  assert.equal(r3.status, 409);
  assert.deepEqual(await r3.json(), { error: 'not_accepted', code: 'key_reuse_different_request' });
  const r4 = await post('shk_b1-k2_secret', 'idem-1', body(5));
  assert.equal(r4.status, 409);
  assert.deepEqual(await r4.json(), { error: 'not_accepted', code: 'key_reuse_other_principal' });
  const s = await get(t, 'idem-1');
  assert.equal(s.status, 200);
  assert.deepEqual(await s.json(), a1);
  assert.equal((await get(t, 'never-used')).status, 404);
  assert.equal((await get('shk_b1-k2_secret', 'idem-1')).status, 409);
});

test('C10 book over HTTP: a booking that exceeds the funds is refused with insufficient_funds and both amounts as micros strings', async () => {
  const { post } = await api({ balance: 500n });
  const r = await post('shk_b1-k1_secret', 'poor', body(8, 60, 120));
  assert.equal(r.status, 200);
  const j = (await r.json()) as Record<string, unknown>;
  assert.equal(j['state'], 'rejected');
  assert.equal(j['reason'], 'insufficient_funds');
  assert.deepEqual(j['amounts'], {
    top_up_min: { currency: 'USD', micros: '460' },
    top_up_min_plus_low_balance_warning: { currency: 'USD', micros: '1000460' },
  });
});

test('C10 malformed and unauthenticated: 400 NotAccepted{malformed} records nothing and the key stays usable; 401 is identical and not before 5 ms', async () => {
  const { h, post } = await api();
  const t = 'shk_b1-k1_secret';
  const before = h.rt.appends.length;
  for (const [key, b] of [
    [undefined, body()], ['.', body()], ['x'.repeat(129), body()], ['m1', '{not json'],
    ['m1', { ...body(), rate_mbps: '5' }], ['m1', { ...body(), deadline_ms: 1.5 }], ['m1', { legs: ['L1'] }],
  ] as const) {
    const r = await post(t, key, b);
    assert.equal(r.status, 400, JSON.stringify(key));
    assert.deepEqual(await r.json(), { error: 'not_accepted', code: 'malformed' });
  }
  assert.equal(h.rt.appends.length, before, 'nothing recorded');
  assert.equal((await post(t, 'm1', body())).status, 200, 'the key was not consumed');
  const bodies = new Set<string>();
  for (const tok of [undefined, 'shk_nobody_x', 'garbage']) {
    const t0 = performance.now();
    const r = await post(tok, 'u1', body());
    assert.equal(r.status, 401);
    bodies.add(await r.text());
    assert.ok(performance.now() - t0 >= 5);
  }
  assert.equal(bodies.size, 1, 'identical body for every cause');
});

test('C10 invalid at the owner (P2-S12 deadline row): recorded under the key as invalid invalid_deadline, and a retry returns it', async () => {
  const { post } = await api();
  const t = 'shk_b1-k1_secret';
  const r1 = await post(t, 'dl', { ...body(), deadline_ms: 61_000 });
  const j1 = (await r1.json()) as Record<string, unknown>;
  assert.equal(r1.status, 200);
  assert.equal(j1['state'], 'invalid');
  assert.equal(j1['reason'], 'invalid_deadline');
  const r2 = await post(t, 'dl', { ...body(), deadline_ms: 61_000 });
  assert.deepEqual(await r2.json(), j1);
});
