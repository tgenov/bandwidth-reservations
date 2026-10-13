/**
 * Property (C01 §3.8, CP-10; RFC-006 §7.1): over seeded random account sets and seeded interleavings of a doubling
 * from n = 4 to 8 (F9 and limit answers, acks, takeovers, refused listings), every published version routes each
 * ordinary account to its old slot s or, only after its move returned, to s + n, and never to s + n before the 2n
 * version. Every published version also routes each designated probe account to its own slot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HlcTs, SlotMapVersion, SlotNo } from '../src/api.ts';
import { hex, utf8 } from '../src/bytes.ts';
import { hlc } from '../src/hlc.ts';
import { home } from '../src/home.ts';
import { slotOfInMap } from '../src/placement/slot-map.ts';
import { DevSummarySigner } from '../src/placement/probe-set.ts';
import { MemorySlotMapStore, SlotMapService } from '../src/placement/slot-map-service.ts';
import { rng } from './support.ts';

const N = 4;
const SEEDS = 300;
const MAX_ACTIONS = 3_000;

function homeAccount(prefix: string, slot: SlotNo): Uint8Array {
  for (let i = 0; ; i++) {
    const a = utf8(`${prefix}-${i}`);
    if (home(a) % N === slot) return a;
  }
}

async function runSeed(seed: number): Promise<void> {
  const r = rng(seed);
  const pick = (k: number): number => Math.floor(r() * k);
  const accounts = Array.from({ length: 20 + pick(60) }, () => new Uint8Array(Array.from({ length: 6 + pick(6) }, () => pick(256))));
  const ordinary = new Set(accounts.map(hex));
  const probes = Array.from({ length: N }, (_, s) => ({ slot: s, account: homeAccount(`p-${seed}-${s}`, s) }));
  const returned = new Set<string>();
  const designated: Array<{ slot: SlotNo; account: Uint8Array }> = [];
  const epochs = new Map<SlotNo, bigint>();
  let twoN = false;
  let tick = 1;

  const check = (v: SlotMapVersion): void => {
    if (v.slotCount === 2 * N && v.previousCount === N) twoN = true;
    for (const a of accounts) {
      const s = home(a) % N;
      const got = slotOfInMap(v, a).slot;
      if (got === s) continue;
      assert.equal(got, s + N, `seed ${seed}: v${v.version} routes ${hex(a)} to ${got}, not ${s} or ${s + N}`);
      assert.ok(twoN, `seed ${seed}: v${v.version} routes ${hex(a)} to ${got} before the 2n version`);
      assert.ok(returned.has(hex(a)), `seed ${seed}: v${v.version} routes ${hex(a)} to ${got} before its move returned`);
    }
    designated.push(...v.probeAccounts);
    for (const p of designated) assert.equal(slotOfInMap(v, p.account).slot, p.slot, `seed ${seed}: v${v.version} moves probe account of slot ${p.slot}`);
    assert.deepEqual(designated.map((p) => p.slot).sort((a, b) => a - b), Array.from({ length: designated.length }, (_, i) => i), `seed ${seed}: one probe per slot`);
  };

  const holderList = (s: SlotNo): Uint8Array[] => [...accounts, ...probes.map((p) => p.account)].filter((a) => home(a) % (2 * N) === s + N);
  const svc = await SlotMapService.open({
    store: new MemorySlotMapStore(),
    publish: async (v) => { check(v); },
    leaseNewSlots: async () => {},
    identity: { provisionProbeAccount: async (slot) => utf8(`new-${seed}-${slot}`) },
    accountOwner: { f9Applied: async () => r() < 0.6 },
    finance: { applySetScopedLimit: async (_v, set) => set.map((m) => ({ account: m.account, applied: r() < 0.7 })) },
    moves: {
      move: async (req) => {
        assert.ok(ordinary.has(hex(req.partition)), `seed ${seed}: moves a non-ordinary account ${hex(req.partition)}`);
        assert.deepEqual([req.from, req.to], [home(req.partition) % N, home(req.partition) % N + N], `seed ${seed}: move slots`);
        assert.ok(!returned.has(hex(req.partition)), `seed ${seed}: moves ${hex(req.partition)} twice`);
        returned.add(hex(req.partition));
        return { generation: 2 };
      },
    },
    holders: {
      listPartitions: async (req) => {
        if (r() < 0.4) return { refused: r() < 0.5 ? 'NOT_ACKED' : 'NOT_OWNER' };
        const e = (epochs.get(req.slot) ?? 0n) + 1n;
        epochs.set(req.slot, e);
        return { partitions: holderList(req.slot), asOf: hlc(BigInt(tick++)), epoch: e };
      },
    },
    signer: new DevSummarySigner({ seed: new Uint8Array(32).fill(3) }),
    clock: (): HlcTs => hlc(BigInt(tick++)),
  });
  await svc.bootstrap({ slotCount: N, probeAccounts: probes });
  await svc.doubleSlotCount({ kind: 'account', requestId: utf8(`d-${seed}`), envelope: {} });

  for (let i = 0; i < MAX_ACTIONS && svc.doublingState()?.phase !== 'done'; i++) {
    const x = r();
    const splitting = (svc.doublingState()?.slots ?? []).filter((s) => s.state === 'splitting');
    const sp = splitting[pick(Math.max(1, splitting.length))];
    if (x < 0.6 || !sp || sp.splittingVersion === undefined) {
      await svc.advanceDoubling();
    } else if (x < 0.85) {
      const e = (epochs.get(sp.slot) ?? 0n) + 1n;
      epochs.set(sp.slot, e);
      await svc.ackSplitting({ kind: 'account', slot: sp.slot, mapVersion: sp.splittingVersion, epoch: e, upperHalf: holderList(sp.slot), asOf: hlc(BigInt(tick++)) });
    } else {
      await svc.holderChanged(sp.slot);
    }
  }
  assert.equal(svc.doublingState()?.phase, 'done', `seed ${seed}: the doubling did not finish in ${MAX_ACTIONS} actions`);
  const last = svc.latest();
  for (const a of accounts) {
    const s = home(a) % N;
    const up = home(a) % (2 * N) === s + N;
    assert.equal(slotOfInMap(last, a).slot, up ? s + N : s, `seed ${seed}: final slot of ${hex(a)}`);
    assert.equal(returned.has(hex(a)), up, `seed ${seed}: ${hex(a)} moved only if upper half`);
  }
}

test('C01 CP-10 property: no ordinary account routes to s + n before the 2n version or before its move returned', { timeout: 120_000 }, async () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    try {
      await runSeed(seed);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      throw new Error(m.startsWith(`seed ${seed}:`) ? m : `seed ${seed}: ${m}`, { cause: e });
    }
  }
});
