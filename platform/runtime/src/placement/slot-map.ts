/**
 * The account slot map feed `placement.slot_map.v1` (C01 §2.7, §3.8; plan S-PLAT-I1: a fixed map).
 *
 * Placement publishes SlotMapVersion records, keyed by version, on one partition. The cache applies them in
 * version order: a version at or below the current one is ignored; the same version with other content is
 * impossible (insert-only), so the cache stops routing and alerts (C01 §5).
 * slotOf (R47-29): an override if any; else h = home(account) (first 4 bytes of SHA-256, big-endian, mod 2^20)
 * and s = h mod n; a splitting slot answers `s` with headDecides for its upper half.
 */
import { randomUUID } from 'node:crypto';
import type { HlcTs, MapVersion, SlotMapVersion, SlotNo, SlotOfAnswer } from '../api.ts';
import { decodeJson, encodeJson, hex } from '../bytes.ts';
import { home } from '../home.ts';
import type { BusSubscription, FeedBus } from '../feed/bus.ts';

export const SLOT_MAP_TOPIC = 'placement.slot_map.v1';

/** The fixed map of I1: version 1, n slots, nothing splitting, no overrides, no probe accounts. */
export function fixedSlotMap(slotCount: number, publishedAt: HlcTs): SlotMapVersion {
  return { version: 1n, slotCount, splitState: {}, overrides: [], probeAccounts: [], publishedAt };
}

export function encodeSlotMap(v: SlotMapVersion): Uint8Array {
  return encodeJson(v);
}

export function decodeSlotMap(b: Uint8Array): SlotMapVersion {
  return decodeJson(b) as SlotMapVersion;
}

/** Placement side: publish one version (key = version, one partition, so versions stay in order). */
export async function publishSlotMap(bus: FeedBus, v: SlotMapVersion): Promise<void> {
  if ((await bus.partitionCount(SLOT_MAP_TOPIC)) === 0) await bus.ensureTopic(SLOT_MAP_TOPIC, 1);
  await bus.produce(SLOT_MAP_TOPIC, [{ key: new Uint8Array(Buffer.from(v.version.toString())), value: encodeSlotMap(v), partition: 0 }]);
}

/** slotOf on one map version (C01 §3.8, R47-29). */
export function slotOfInMap(v: SlotMapVersion, account: Uint8Array): SlotOfAnswer {
  const o = v.overrides.find((x) => hex(x.account) === hex(account));
  if (o) return { slot: o.slot, mapVersion: v.version, headDecides: false };
  const h = home(account);
  const n = v.previousCount ?? v.slotCount;
  const s = h % n;
  if (v.previousCount === undefined) return { slot: s, mapVersion: v.version, headDecides: false };
  const state = v.splitState[s] ?? 'unsplit';
  if (state === 'unsplit') return { slot: s, mapVersion: v.version, headDecides: false };
  if (state === 'split') return { slot: h % (2 * n), mapVersion: v.version, headDecides: false };
  // Splitting: the lower half stays in s; the upper half is sent to s and follows MOVED (headDecides).
  return { slot: s, mapVersion: v.version, headDecides: h % (2 * n) === s + n };
}

export interface SlotMapCacheOptions {
  bus: FeedBus;
  /** Consumer group (each process reads the whole feed; default a unique group). */
  groupId?: string;
  alert?: (reason: string, fields: Record<string, unknown>) => void;
}

/** The runtime's placement cache for the account slot map. */
export class SlotMapCache {
  private readonly o: SlotMapCacheOptions | undefined;
  private v: SlotMapVersion | undefined;
  private readonly seen = new Map<string, string>();
  private sub: BusSubscription | undefined;
  /** Set when the feed broke the insert-only rule; routing stops. */
  broken = false;

  constructor(o?: SlotMapCacheOptions) {
    this.o = o;
  }

  current(): SlotMapVersion | undefined {
    return this.broken ? undefined : this.v;
  }

  version(): MapVersion | undefined {
    return this.v?.version;
  }

  /** Apply one version from the feed (in version order; duplicates ignored). */
  apply(v: SlotMapVersion): void {
    const key = v.version.toString();
    const body = hex(encodeSlotMap(v));
    const prev = this.seen.get(key);
    if (prev !== undefined) {
      if (prev !== body) {
        this.broken = true;
        this.o?.alert?.('SLOT_MAP_CONFLICT', { version: key });
      }
      return;
    }
    this.seen.set(key, body);
    if (this.v === undefined || v.version > this.v.version) this.v = v;
  }

  slotOf(account: Uint8Array): SlotOfAnswer | undefined {
    const v = this.current();
    return v ? slotOfInMap(v, account) : undefined;
  }

  async start(): Promise<void> {
    if (!this.o) throw new Error('SlotMapCache.start needs a bus');
    this.sub = await this.o.bus.subscribe({
      groupId: this.o.groupId ?? `slotmap-${process.pid}-${randomUUID()}`, topics: [SLOT_MAP_TOPIC], fromBeginning: true,
      onRecord: async (r) => { if (r.value) this.apply(decodeSlotMap(r.value)); },
    });
  }

  /** Resolves once a version is applied (or after the timeout). */
  async ready(timeoutMs = 10_000): Promise<boolean> {
    // An elapsed time: the monotonic clock, not the wall clock (engineering.md §5).
    const end = performance.now() + timeoutMs;
    while (!this.v && performance.now() < end) await new Promise((r) => setTimeout(r, 20));
    return this.v !== undefined;
  }

  async stop(): Promise<void> {
    await this.sub?.stop();
  }
}

export type { SlotNo };
