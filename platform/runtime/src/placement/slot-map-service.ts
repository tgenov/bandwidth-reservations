/**
 * Placement's account slot map service (C01 §2.7, §3.8, §3.10, §5; RFC-006 §7.1; plan S-PLAT-I3 work items 6, 7, 8).
 *
 * The service keeps the insert-only map history through a `SlotMapStore`, publishes each new version on the feed,
 * and drives the doubling `n → 2n` in the C01 §3.8 order 1 to 7. All mutating operations run one at a time.
 * The doubling is driven step by step (`advanceDoubling`): each call does at most one action, so a caller (a timer in
 * production, the test in a unit test) controls the interleaving, and no step waits for wall-clock time.
 */
import { createHash } from 'node:crypto';
import type { Epoch, HlcTs, MapVersion, OperatorEnvelope, OwnerKind, SlotMapVersion, SlotNo, SlotOfAnswer, SplitState } from '../api.ts';
import { bytesEqual, decodeJson, encodeJson, fromHex, hex } from '../bytes.ts';
import { home, isPowerOfTwo } from '../home.ts';
import { slotOfInMap } from './slot-map.ts';
import { signProbeSetSummary, sortProbeSet, type ProbeMember, type ProbeSetSummary, type SummarySigner } from './probe-set.ts';

/** RFC-006 §7.1 `split_parallelism`: old slots splitting at the same time. */
export const SPLIT_PARALLELISM = 16;

/**
 * Kafka partitions of an account topic for a slot count (C01 §2.5, R47-30): the least power of two that is at least
 * slotCount / 4. The growth step after a doubling is an estimate; SP2 decides it (plan S-PLAT-I3 work item 8).
 */
export function accountTopicPartitions(slotCount: number): number {
  const target = Math.ceil(slotCount / 4);
  let p = 1;
  while (p < target) p *= 2;
  return p;
}

// ---------- store port ----------

/** A row of `placement_probe_accounts` (C01 §2.3). */
export interface ProbeAccountRow { slot: SlotNo; account: Uint8Array; designatedIn: MapVersion; limitState: 'pending' | 'applied' }

/** A row of `placement_split_acks` (C01 §2.3) with the upper-half list that RFC-006 §7.1 records with it. */
export interface SplitAckRow { slot: SlotNo; mapVersion: MapVersion; epoch: Epoch; ackedAt: HlcTs; upperHalf: Uint8Array[] }

/** A recorded `reslot` or `doubleSlotCount` request (C01 §5: idempotent by requestId). `answer` is encodeJson bytes. */
export interface RequestRow { requestId: Uint8Array; op: 'reslot' | 'double'; digest: Uint8Array; answer: Uint8Array }

/** The progress of one old slot during a doubling. `moved` holds the hex of each account whose move returned. */
export interface SlotProgress { slot: SlotNo; state: SplitState; splittingVersion?: MapVersion; moved: string[]; needsListing: boolean }

/** The phase of a doubling: the next C01 §3.8 step to do. */
export type DoublingPhase = 'lease' | 'provision' | 'f9' | 'limit' | 'count' | 'split' | 'done';

/** The persisted state of the current (or last) doubling. Account lists are hex. */
export interface DoublingState {
  requestId: string; fromCount: number; toCount: number; phase: DoublingPhase;
  overrideVersion?: MapVersion; limitVersion?: MapVersion;
  newProbes: string[]; f9Done: string[];
  slots: SlotProgress[];
}

/** Placement's durable state for the account slot map (memory: `MemorySlotMapStore`; CockroachDB: `PgSlotMapStore`). */
export interface SlotMapStore {
  /** Every recorded version, in version order. */
  versions(): Promise<SlotMapVersion[]>;
  /** Insert-only: the same version with the same content is a no-op; with other content it throws (C01 §5). */
  insertVersion(v: SlotMapVersion): Promise<void>;
  probeAccounts(): Promise<ProbeAccountRow[]>;
  /** Insert or replace the row of `r.slot`. */
  putProbeAccount(r: ProbeAccountRow): Promise<void>;
  splitAck(slot: SlotNo, mapVersion: MapVersion): Promise<SplitAckRow | undefined>;
  /** Insert or replace the ack of (slot, mapVersion). */
  putSplitAck(r: SplitAckRow): Promise<void>;
  request(requestId: Uint8Array): Promise<RequestRow | undefined>;
  /** Insert once: a second put of the same requestId is ignored. */
  putRequest(r: RequestRow): Promise<void>;
  doubling(): Promise<DoublingState | undefined>;
  putDoubling(s: DoublingState): Promise<void>;
}

const copy = <T>(v: T): T => decodeJson(encodeJson(v)) as T;

/** The in-memory `SlotMapStore` (unit tests). Values are copied in and out, as a database would. */
export class MemorySlotMapStore implements SlotMapStore {
  private readonly vs = new Map<string, SlotMapVersion>();
  private readonly probes = new Map<SlotNo, ProbeAccountRow>();
  private readonly acks = new Map<string, SplitAckRow>();
  private readonly requests = new Map<string, RequestRow>();
  private state: DoublingState | undefined;

  async versions(): Promise<SlotMapVersion[]> {
    return [...this.vs.values()].sort((a, b) => (a.version < b.version ? -1 : 1)).map(copy);
  }

  async insertVersion(v: SlotMapVersion): Promise<void> {
    const key = v.version.toString();
    const prev = this.vs.get(key);
    if (prev && !bytesEqual(encodeJson(prev), encodeJson(v))) throw new SlotMapError('VERSION_CONFLICT', `version ${key} exists with other content`);
    if (!prev) this.vs.set(key, copy(v));
  }

  async probeAccounts(): Promise<ProbeAccountRow[]> {
    return [...this.probes.values()].sort((a, b) => a.slot - b.slot).map(copy);
  }

  async putProbeAccount(r: ProbeAccountRow): Promise<void> { this.probes.set(r.slot, copy(r)); }

  async splitAck(slot: SlotNo, mapVersion: MapVersion): Promise<SplitAckRow | undefined> {
    const r = this.acks.get(`${slot}:${mapVersion}`);
    return r && copy(r);
  }

  async putSplitAck(r: SplitAckRow): Promise<void> { this.acks.set(`${r.slot}:${r.mapVersion}`, copy(r)); }

  async request(requestId: Uint8Array): Promise<RequestRow | undefined> {
    const r = this.requests.get(hex(requestId));
    return r && copy(r);
  }

  async putRequest(r: RequestRow): Promise<void> {
    if (!this.requests.has(hex(r.requestId))) this.requests.set(hex(r.requestId), copy(r));
  }

  async doubling(): Promise<DoublingState | undefined> { return this.state && copy(this.state); }

  async putDoubling(s: DoublingState): Promise<void> { this.state = copy(s); }
}

// ---------- ports and errors ----------

/** Error codes of the service that C01 §2.7 gives no answer type for (see the design issues in the report). */
export type SlotMapErrorCode =
  | 'NOT_BOOTSTRAPPED' | 'ALREADY_BOOTSTRAPPED' | 'BAD_BOOTSTRAP' | 'NOT_ACCOUNT_KIND' | 'CONFLICT'
  | 'DOUBLING_IN_PROGRESS' | 'NOT_SPLITTING' | 'UNKNOWN_VERSION' | 'VERSION_CONFLICT';

/** An error of the slot map service with an exact code. */
export class SlotMapError extends Error {
  readonly code: SlotMapErrorCode;
  constructor(code: SlotMapErrorCode, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

/** C01 §2.7 HolderPlacementApi.listPartitions (placement → the slot's holder). */
export interface HolderPartitionLister {
  listPartitions(req: { kind: 'account'; slot: SlotNo; mapVersion: MapVersion; home: { mod: number; eq: number } }):
    Promise<{ partitions: Uint8Array[]; asOf: HlcTs; epoch: Epoch } | { refused: 'NOT_ACKED' | 'NOT_OWNER' }>;
}

/** The ports of the service. */
export interface SlotMapServiceOptions {
  store: SlotMapStore;
  /** Publishes one version on `placement.slot_map.v1` (for example `publishSlotMap`). */
  publish(v: SlotMapVersion): Promise<void>;
  /** C01 §3.8 step 1: lease the new slots (their `owner_slot` rows and holders). */
  leaseNewSlots(kind: 'account', slots: SlotNo[]): Promise<void>;
  /** Identity (B4; no frozen contract): provisions a Share-internal probe account, KYB passed. */
  identity: { provisionProbeAccount(slot: SlotNo): Promise<Uint8Array> };
  /** The account owner (C05): true once F9 is applied for the account with the designating version. */
  accountOwner: { f9Applied(account: Uint8Array, version: MapVersion): Promise<boolean> };
  /** Finance (C07): the set-scoped credit-limit action over probeAccountSet(version). */
  finance: { applySetScopedLimit(version: MapVersion, set: ProbeMember[]): Promise<Array<{ account: Uint8Array; applied: boolean }>> };
  /** The move coordinator (C01 §3.3): resolves when the move of the partition is done. */
  moves: { move(req: { kind: 'account'; partition: Uint8Array; from: SlotNo; to: SlotNo }): Promise<{ generation: number }> };
  holders: HolderPartitionLister;
  /** Grows the account topics to `count` partitions after the 2n version (R47-30; est., SP2 decides). */
  growTopics?(count: number): Promise<void>;
  signer: SummarySigner;
  /** The HLC source for `publishedAt` and `acked_at`. */
  clock(): HlcTs;
  /** Configured slot groups (RFC-006 §7.1 `slot_groups`). */
  slotGroups?: Array<Array<{ kind: OwnerKind; slot: SlotNo }>>;
  splitParallelism?: number;
}

/** C01 §2.7 reslot request. */
export interface ReslotRequest { accounts: Uint8Array[]; toSlot: SlotNo; reason: string; requestId: Uint8Array; envelope: OperatorEnvelope }
/** C01 §2.7 reslot refusal codes. */
export type ReslotRefusal = 'PROBE_LEFT_WITHOUT' | 'SECOND_PROBE' | 'TARGET_WITHOUT_PROBE' | 'NOT_DOUBLING' | 'CONFLICT';
/** C01 §2.7 reslot answer. */
export type ReslotAnswer = { accepted: true; versionWhenDone?: MapVersion } | { accepted: false; refusal: ReslotRefusal };
/** C01 §2.7 ackSplitting request. */
export interface AckSplittingRequest { kind: 'account'; slot: SlotNo; mapVersion: MapVersion; epoch: Epoch; upperHalf: Uint8Array[]; asOf: HlcTs }

/** What one `advanceDoubling` call did. */
export type DoublingStep =
  | 'idle' | 'leased' | 'override-published' | 'f9-waiting' | 'f9-applied' | 'limit-waiting' | 'limit-applied'
  | 'limit-stale' | 'count-published' | 'splitting-published' | 'listing-refused' | 'listed' | 'moved' | 'split-published'
  | 'waiting' | 'done';

const sha256 = (b: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(b).digest());
type Override = SlotMapVersion['overrides'][number];
const sortOverrides = (o: Override[]): Override[] => [...o].sort((a, b) => (hex(a.account) < hex(b.account) ? -1 : 1));

/** Placement's account slot map: PlacementApi of C01 §2.7 and the doubling of §3.8. */
export class SlotMapService {
  private readonly o: SlotMapServiceOptions;
  private history: SlotMapVersion[] = [];
  private probes = new Map<SlotNo, ProbeAccountRow>();
  private dbl: DoublingState | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(o: SlotMapServiceOptions) { this.o = o; }

  /** Opens the service on its store (loads the history, the probe accounts and the doubling state). */
  static async open(o: SlotMapServiceOptions): Promise<SlotMapService> {
    const s = new SlotMapService(o);
    s.history = await o.store.versions();
    s.probes = new Map((await o.store.probeAccounts()).map((r) => [r.slot, r]));
    s.dbl = await o.store.doubling();
    return s;
  }

  /** Runs mutating operations one at a time (the placement holder is one writer). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  /**
   * Version 1 of an empty store: `slotCount` slots, each with its probe account placed by its home (h mod n = slot),
   * limits already applied. The first designation is outside C01 §3.8 (see the report).
   */
  bootstrap(o: { slotCount: number; probeAccounts: ProbeMember[] }): Promise<SlotMapVersion> {
    return this.serial(async () => {
      if (this.history.length > 0) throw new SlotMapError('ALREADY_BOOTSTRAPPED');
      if (!isPowerOfTwo(o.slotCount)) throw new SlotMapError('BAD_BOOTSTRAP', `slot count ${o.slotCount} is not a power of two`);
      const bySlot = new Map(o.probeAccounts.map((p) => [p.slot, p]));
      for (let s = 0; s < o.slotCount; s++) {
        const p = bySlot.get(s);
        if (!p || home(p.account) % o.slotCount !== s) throw new SlotMapError('BAD_BOOTSTRAP', `slot ${s} has no probe account placed by its home`);
      }
      if (o.probeAccounts.length !== o.slotCount) throw new SlotMapError('BAD_BOOTSTRAP', 'one probe account per slot');
      const v: SlotMapVersion = {
        version: 1n, slotCount: o.slotCount, splitState: {}, overrides: [],
        probeAccounts: sortProbeSet(o.probeAccounts), publishedAt: this.o.clock(),
      };
      for (const p of o.probeAccounts) await this.putProbe({ slot: p.slot, account: p.account, designatedIn: 1n, limitState: 'applied' });
      await this.publishVersion(v);
      return v;
    });
  }

  /** The latest published version. */
  latest(): SlotMapVersion {
    const v = this.history.at(-1);
    if (!v) throw new SlotMapError('NOT_BOOTSTRAPPED');
    return v;
  }

  /** Every published version, in order. */
  published(): SlotMapVersion[] { return [...this.history]; }

  /** The doubling state (a copy), if a doubling was requested. */
  doublingState(): DoublingState | undefined { return this.dbl && copy(this.dbl); }

  /** C01 §3.8 slotOf on the latest published version. */
  slotOf(account: Uint8Array): SlotOfAnswer {
    return slotOfInMap(this.latest(), account);
  }

  /** C01 §2.7 slotGroup: the configured group that holds (kind, slot), else the single member. */
  slotGroup(kind: OwnerKind, slot: SlotNo): Array<{ kind: OwnerKind; slot: SlotNo }> {
    const g = (this.o.slotGroups ?? []).find((m) => m.some((x) => x.kind === kind && x.slot === slot));
    return g ? g.map((x) => ({ ...x })) : [{ kind, slot }];
  }

  /**
   * C01 §2.7 probeAccountSet(v): the exact set of version v. v may be the next, unpublished version (C07 S1: the limit
   * of step 5 is set before the 2n version of step 6 exists); its set is every designated probe account.
   */
  async probeAccountSet(v: MapVersion): Promise<ProbeMember[]> {
    const latest = this.latest().version;
    if (v < 1n || v > latest + 1n) throw new SlotMapError('UNKNOWN_VERSION', `version ${v}`);
    if (v === latest + 1n) return sortProbeSet([...this.probes.values()].map((p) => ({ slot: p.slot, account: p.account })));
    return sortProbeSet(this.history.filter((x) => x.version <= v).flatMap((x) => x.probeAccounts.map((p) => ({ slot: p.slot, account: p.account }))));
  }

  /** C01 §2.7 probeSetSummary(v), signed with placement's summary key; also for the next, unpublished version. */
  async probeSetSummary(v: MapVersion): Promise<ProbeSetSummary> {
    const set = await this.probeAccountSet(v);
    const latest = this.latest();
    const pendingCount = this.dbl && ['f9', 'limit', 'count'].includes(this.dbl.phase) ? this.dbl.toCount : latest.slotCount;
    const slotCount = v === latest.version + 1n ? pendingCount : this.versionOf(v).slotCount;
    return signProbeSetSummary(v, slotCount, set, this.o.signer);
  }

  /** C01 §2.7 reslot: refusals of §3.8, then moves one account at a time, then a version with the override rows. */
  reslot(req: ReslotRequest): Promise<ReslotAnswer> {
    const digest = sha256(encodeJson({ op: 'reslot', accounts: req.accounts, toSlot: req.toSlot, reason: req.reason }));
    return this.serial(async () => {
      const prior = await this.o.store.request(req.requestId);
      if (prior) {
        return prior.op === 'reslot' && bytesEqual(prior.digest, digest)
          ? decodeJson(prior.answer) as ReslotAnswer
          : { accepted: false, refusal: 'CONFLICT' };
      }
      const refusal = this.reslotRefusal(req);
      const answer: ReslotAnswer = refusal ? { accepted: false, refusal } : await this.applyReslot(req);
      await this.o.store.putRequest({ requestId: req.requestId, op: 'reslot', digest, answer: encodeJson(answer) });
      return answer;
    });
  }

  private reslotRefusal(req: ReslotRequest): ReslotRefusal | undefined {
    const latest = this.latest();
    const leased = this.dbl && this.dbl.phase !== 'lease' && this.dbl.phase !== 'done' ? this.dbl.toCount : latest.slotCount;
    const known = Math.max(latest.slotCount, leased);
    if (!Number.isInteger(req.toSlot) || req.toSlot < 0 || req.toSlot >= known) return 'NOT_DOUBLING';
    const probeSlot = new Map([...this.probes.values()].map((p) => [hex(p.account), p.slot]));
    const targetHasProbe = [...this.probes.values()].some((p) => p.slot === req.toSlot);
    for (const a of req.accounts) {
      const s = probeSlot.get(hex(a));
      // C01 §3.8 gives no precedence: a probe account sent to a probed slot is SECOND_PROBE, else PROBE_LEFT_WITHOUT.
      if (s !== undefined && s !== req.toSlot) return targetHasProbe ? 'SECOND_PROBE' : 'PROBE_LEFT_WITHOUT';
    }
    if (!targetHasProbe) return 'TARGET_WITHOUT_PROBE';
    // A leased new slot is not in the count before step 6: no ordinary account routes there before it (C01 §3.8).
    if (req.toSlot >= latest.slotCount) return 'NOT_DOUBLING';
    return undefined;
  }

  private async applyReslot(req: ReslotRequest): Promise<ReslotAnswer> {
    const latest = this.latest();
    const probe = new Set([...this.probes.values()].map((p) => hex(p.account)));
    const overrides = new Map(latest.overrides.map((x) => [hex(x.account), x]));
    for (const a of req.accounts) {
      if (probe.has(hex(a))) continue; // A probe account sent to its own slot: nothing to do.
      const from = slotOfInMap(latest, a).slot;
      if (from !== req.toSlot) await this.o.moves.move({ kind: 'account', partition: a, from, to: req.toSlot });
      overrides.set(hex(a), { account: a, slot: req.toSlot, reason: 'reslot' });
    }
    const v = this.next(latest, { overrides: [...overrides.values()] });
    await this.publishVersion(v);
    return { accepted: true, versionWhenDone: v.version };
  }

  /** C01 §2.7 doubleSlotCount: records the request (idempotent by requestId); `advanceDoubling` does the steps. */
  doubleSlotCount(req: { kind: 'account'; requestId: Uint8Array; envelope: OperatorEnvelope }): Promise<{ targetCount: number }> {
    const digest = sha256(encodeJson({ op: 'double', kind: req.kind }));
    return this.serial(async () => {
      if (req.kind !== 'account') throw new SlotMapError('NOT_ACCOUNT_KIND', String(req.kind));
      const prior = await this.o.store.request(req.requestId);
      if (prior) {
        if (prior.op !== 'double' || !bytesEqual(prior.digest, digest)) throw new SlotMapError('CONFLICT', hex(req.requestId));
        return decodeJson(prior.answer) as { targetCount: number };
      }
      if (this.dbl && this.dbl.phase !== 'done') throw new SlotMapError('DOUBLING_IN_PROGRESS', this.dbl.requestId);
      const n = this.latest().slotCount;
      const st: DoublingState = {
        requestId: hex(req.requestId), fromCount: n, toCount: 2 * n, phase: 'lease', newProbes: [], f9Done: [],
        slots: Array.from({ length: n }, (_, s) => ({ slot: s, state: 'unsplit' as const, moved: [], needsListing: false })),
      };
      await this.saveDoubling(st);
      const answer = { targetCount: 2 * n };
      await this.o.store.putRequest({ requestId: req.requestId, op: 'double', digest, answer: encodeJson(answer) });
      return answer;
    });
  }

  /**
   * C01 §2.7 ackSplitting (R47-05): recorded once per (slot, mapVersion, epoch); a later epoch's list replaces an
   * earlier one's. Placement then moves exactly the listed upper-half accounts (`advanceDoubling`).
   */
  ackSplitting(req: AckSplittingRequest): Promise<{ recorded: true }> {
    return this.serial(async () => {
      if (req.kind !== 'account') throw new SlotMapError('NOT_ACCOUNT_KIND', String(req.kind));
      const sp = this.dbl?.slots.find((x) => x.slot === req.slot);
      if (!sp || sp.splittingVersion !== req.mapVersion) throw new SlotMapError('NOT_SPLITTING', `slot ${req.slot} version ${req.mapVersion}`);
      const prior = await this.o.store.splitAck(req.slot, req.mapVersion);
      if ((prior && req.epoch <= prior.epoch) || sp.state === 'split') return { recorded: true };
      await this.o.store.putSplitAck({ slot: req.slot, mapVersion: req.mapVersion, epoch: req.epoch, ackedAt: req.asOf, upperHalf: req.upperHalf });
      sp.needsListing = false;
      await this.saveDoubling(this.mustDoubling());
      return { recorded: true };
    });
  }

  /** The holder of a splitting slot changed (a takeover): placement asks the new holder with listPartitions. */
  holderChanged(slot: SlotNo): Promise<void> {
    return this.serial(async () => {
      const sp = this.dbl?.slots.find((x) => x.slot === slot);
      if (!sp || sp.state !== 'splitting') return;
      sp.needsListing = true;
      await this.saveDoubling(this.mustDoubling());
    });
  }

  /** Does the next action of the doubling (C01 §3.8 steps 1 to 7) and says which. */
  advanceDoubling(): Promise<DoublingStep> {
    return this.serial(async () => {
      const st = this.dbl;
      if (!st || st.phase === 'done') return 'idle';
      switch (st.phase) {
        case 'lease': return this.stepLease(st);
        case 'provision': return this.stepProvision(st);
        case 'f9': return this.stepF9(st);
        case 'limit': return this.stepLimit(st);
        case 'count': return this.stepCount(st);
        case 'split': return this.stepSplit(st);
      }
    });
  }

  /** Calls `advanceDoubling` until it returns `done`, `idle`, or a waiting step; returns the steps. */
  async runDoubling(maxSteps = 10_000): Promise<DoublingStep[]> {
    const out: DoublingStep[] = [];
    for (let i = 0; i < maxSteps; i++) {
      const s = await this.advanceDoubling();
      out.push(s);
      if (s === 'done' || s === 'idle' || s === 'waiting' || s === 'f9-waiting' || s === 'limit-waiting' || s === 'listing-refused') break;
    }
    return out;
  }

  // ---------- the doubling steps ----------

  /** Step 1: lease the new slots s + n. */
  private async stepLease(st: DoublingState): Promise<DoublingStep> {
    const slots = Array.from({ length: st.toCount - st.fromCount }, (_, i) => st.fromCount + i);
    await this.o.leaseNewSlots('account', slots);
    st.phase = 'provision';
    await this.saveDoubling(st);
    return 'leased';
  }

  /** Steps 2 and 3: pin every existing probe account, provision one per new slot, publish the override version. */
  private async stepProvision(st: DoublingState): Promise<DoublingStep> {
    const latest = this.latest();
    const ver = latest.version + 1n;
    const overrides = new Map(latest.overrides.map((x) => [hex(x.account), x]));
    for (const p of this.probes.values()) {
      if (p.slot >= st.fromCount) continue;
      const o = overrides.get(hex(p.account));
      if (!o || o.slot !== p.slot) overrides.set(hex(p.account), { account: p.account, slot: p.slot, reason: 'probe_pin' });
    }
    const delta: ProbeMember[] = [];
    for (let s = st.fromCount; s < st.toCount; s++) {
      const existing = this.probes.get(s);
      const account = existing?.account ?? await this.o.identity.provisionProbeAccount(s);
      if (!existing || existing.designatedIn !== ver) await this.putProbe({ slot: s, account, designatedIn: ver, limitState: 'pending' });
      overrides.set(hex(account), { account, slot: s, reason: 'probe_new' });
      delta.push({ slot: s, account });
    }
    const v: SlotMapVersion = {
      version: ver, slotCount: st.fromCount, splitState: {}, overrides: sortOverrides([...overrides.values()]),
      probeAccounts: delta, publishedAt: this.o.clock(),
    };
    await this.publishVersion(v);
    st.overrideVersion = ver;
    st.newProbes = delta.map((d) => hex(d.account));
    st.phase = 'f9';
    await this.saveDoubling(st);
    return 'override-published';
  }

  /** Step 4: each new slot's account owner applied F9 for its probe account, with the override version. */
  private async stepF9(st: DoublingState): Promise<DoublingStep> {
    const version = st.overrideVersion ?? 0n;
    for (const a of st.newProbes) {
      if (st.f9Done.includes(a)) continue;
      if (await this.o.accountOwner.f9Applied(fromHex(a), version)) st.f9Done.push(a);
    }
    const all = st.newProbes.every((a) => st.f9Done.includes(a));
    if (all) st.phase = 'limit';
    await this.saveDoubling(st);
    return all ? 'f9-applied' : 'f9-waiting';
  }

  /** Step 5: finance's set-scoped limit over probeAccountSet of the next version; `applied` for every new probe. */
  private async stepLimit(st: DoublingState): Promise<DoublingStep> {
    const v = this.latest().version + 1n;
    const answer = await this.o.finance.applySetScopedLimit(v, await this.probeAccountSet(v));
    const applied = new Set(answer.filter((x) => x.applied).map((x) => hex(x.account)));
    for (const p of this.probes.values()) {
      if (p.limitState === 'pending' && applied.has(hex(p.account))) await this.putProbe({ ...p, limitState: 'applied' });
    }
    const all = st.newProbes.every((a) => [...this.probes.values()].some((p) => hex(p.account) === a && p.limitState === 'applied'));
    if (!all) return 'limit-waiting';
    st.limitVersion = v;
    st.phase = 'count';
    await this.saveDoubling(st);
    return 'limit-applied';
  }

  /** Step 6: publish the 2n version, every old slot unsplit; then grow the account topics. */
  private async stepCount(st: DoublingState): Promise<DoublingStep> {
    const latest = this.latest();
    if (latest.version + 1n !== st.limitVersion) {
      // Another version was published after the limit: the limit must name the version that is published.
      st.phase = 'limit';
      await this.saveDoubling(st);
      return 'limit-stale';
    }
    const splitState: Record<SlotNo, SplitState> = {};
    for (let s = 0; s < st.fromCount; s++) splitState[s] = 'unsplit';
    await this.publishVersion({
      version: latest.version + 1n, slotCount: st.toCount, previousCount: st.fromCount, splitState,
      overrides: latest.overrides, probeAccounts: [], publishedAt: this.o.clock(),
    });
    st.phase = 'split';
    await this.saveDoubling(st);
    await this.o.growTopics?.(accountTopicPartitions(st.toCount));
    return 'count-published';
  }

  /** Step 7: lazy splits, `split_parallelism` at a time, each unsplit → splitting → split by the handshake. */
  private async stepSplit(st: DoublingState): Promise<DoublingStep> {
    const n = st.fromCount;
    for (const sp of st.slots) {
      if (sp.state !== 'splitting' || !sp.needsListing || sp.splittingVersion === undefined) continue;
      const r = await this.o.holders.listPartitions({ kind: 'account', slot: sp.slot, mapVersion: sp.splittingVersion, home: { mod: 2 * n, eq: sp.slot + n } });
      if ('refused' in r) return 'listing-refused';
      const prior = await this.o.store.splitAck(sp.slot, sp.splittingVersion);
      if (!prior || r.epoch > prior.epoch) {
        await this.o.store.putSplitAck({ slot: sp.slot, mapVersion: sp.splittingVersion, epoch: r.epoch, ackedAt: r.asOf, upperHalf: r.partitions });
      }
      sp.needsListing = false;
      await this.saveDoubling(st);
      return 'listed';
    }
    for (const sp of st.slots) {
      if (sp.state !== 'splitting' || sp.needsListing || sp.splittingVersion === undefined) continue;
      const ack = await this.o.store.splitAck(sp.slot, sp.splittingVersion);
      if (!ack) continue;
      const todo = this.movable(ack.upperHalf, sp.slot, n).filter((a) => !sp.moved.includes(hex(a)));
      const a = todo[0];
      if (a === undefined) {
        const latest = this.latest();
        await this.publishVersion(this.next(latest, { splitState: { ...latest.splitState, [sp.slot]: 'split' } }));
        sp.state = 'split';
        await this.saveDoubling(st);
        return 'split-published';
      }
      await this.o.moves.move({ kind: 'account', partition: a, from: sp.slot, to: sp.slot + n });
      sp.moved.push(hex(a));
      await this.saveDoubling(st);
      return 'moved';
    }
    const active = st.slots.filter((x) => x.state === 'splitting').length;
    const start = st.slots.filter((x) => x.state === 'unsplit').slice(0, Math.max(0, (this.o.splitParallelism ?? SPLIT_PARALLELISM) - active));
    if (start.length > 0) {
      const latest = this.latest();
      const splitState = { ...latest.splitState };
      for (const sp of start) splitState[sp.slot] = 'splitting';
      const v = this.next(latest, { splitState });
      await this.publishVersion(v);
      for (const sp of start) { sp.state = 'splitting'; sp.splittingVersion = v.version; }
      await this.saveDoubling(st);
      return 'splitting-published';
    }
    if (st.slots.every((x) => x.state === 'split')) {
      st.phase = 'done';
      await this.saveDoubling(st);
      return 'done';
    }
    return 'waiting';
  }

  /**
   * The listed accounts that placement moves: each once, only upper-half (h mod 2n = s + n), and not one with an
   * override row (a pinned probe account never moves; a re-slotted account follows its override).
   */
  private movable(listed: Uint8Array[], s: SlotNo, n: number): Uint8Array[] {
    const overridden = new Set(this.latest().overrides.map((x) => hex(x.account)));
    const seen = new Set<string>();
    return listed.filter((a) => {
      const k = hex(a);
      if (seen.has(k) || overridden.has(k) || home(a) % (2 * n) !== s + n) return false;
      seen.add(k);
      return true;
    });
  }

  // ---------- helpers ----------

  private versionOf(v: MapVersion): SlotMapVersion {
    const x = this.history.find((h) => h.version === v);
    if (!x) throw new SlotMapError('UNKNOWN_VERSION', `version ${v}`);
    return x;
  }

  private next(latest: SlotMapVersion, o: { overrides?: Override[]; splitState?: Record<SlotNo, SplitState> }): SlotMapVersion {
    return {
      version: latest.version + 1n, slotCount: latest.slotCount,
      ...(latest.previousCount !== undefined ? { previousCount: latest.previousCount } : {}),
      splitState: o.splitState ?? latest.splitState,
      overrides: sortOverrides(o.overrides ?? latest.overrides),
      probeAccounts: [], publishedAt: this.o.clock(),
    };
  }

  private async publishVersion(v: SlotMapVersion): Promise<void> {
    await this.o.store.insertVersion(v);
    this.history.push(v);
    await this.o.publish(v);
  }

  private async putProbe(r: ProbeAccountRow): Promise<void> {
    await this.o.store.putProbeAccount(r);
    this.probes.set(r.slot, r);
  }

  private async saveDoubling(st: DoublingState): Promise<void> {
    this.dbl = st;
    await this.o.store.putDoubling(st);
  }

  private mustDoubling(): DoublingState {
    if (!this.dbl) throw new SlotMapError('NOT_SPLITTING');
    return this.dbl;
  }
}
