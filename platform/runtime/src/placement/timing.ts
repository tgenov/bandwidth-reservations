/**
 * Placement's timing part (RFC-006 §6.4, §6.5; C01 §2.3 `platform_timing`; plan S-PLAT-I2 work item 6).
 *
 * Placement is the only writer of `platform_timing`. It writes a new version to all 64 shards in one
 * transaction, so a confirm transaction that reads its own shard sees either the old version or the new
 * one, never a mix. `TimingAlarms` evaluates the alarms A-T1 … A-T5 from measured δ_x samples, offset ladder
 * levels and late releases. `TimingProbe` drives the synthetic expiry-and-release round trips.
 */
import type { HlcTs, OperationalAlert, Seq, TimingSnapshot } from '../api.ts';
import { systemClock, type WallClock } from '../clock.ts';
import { hlcParts } from '../hlc.ts';
import { PARAMS } from '../params.ts';

/** C01 §2.3 `second_lane` JSONB: per owner kind, the lanes that are on. Lane (c) is not in C01 v1. */
export type SecondLaneSettings = Record<string, { account?: boolean; deadline?: boolean }>;

/** The configured values of one `platform_timing` version, without its version number (RFC-006 §6.4). */
export interface TimingVersion { epsilonMs: number; deltaXMs: number; tauMs: number; secondLane: SecondLaneSettings }

/** Timing constants of RFC-006 §6.4 and §6.5. `ackBudgetMs` is POL-04 `ack_budget` (policy register: 200 ms at p99). */
export const TIMING = {
  ackBudgetMs: 200,
  tauCapMs: 450,
  deltaXCfgMs: 320,
  epsilonCfgMs: 100,
  fastAttackMarginMs: 20,
  roundToMs: 10,
  at1MarginMs: 30,
  at1HoldMs: 5 * 60_000,
  at2HoldMs: 60_000,
  windowMs: 5 * 60_000,
} as const;

/** τ = max(ack_budget, ε + δ_x) (RFC-006 §6.4; RFC-000 §4.3). */
export function tauFor(epsilonMs: number, deltaXMs: number, ackBudgetMs: number = TIMING.ackBudgetMs): number {
  return Math.max(ackBudgetMs, epsilonMs + deltaXMs);
}

/** The reason why placement refuses to write a timing version. */
export type TimingRefusalCode =
  | 'NOT_WHOLE_MS' | 'TAU_BELOW_EPSILON_PLUS_DELTA_X' | 'TAU_BELOW_ACK_BUDGET' | 'TAU_ABOVE_CAP' | 'SHARDS_MISSING';

/** Thrown by `writeTimingVersion` for a version that it must not write. No row changes. */
export class TimingVersionRefused extends Error {
  readonly code: TimingRefusalCode;
  constructor(code: TimingRefusalCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'TimingVersionRefused';
    this.code = code;
  }
}

/** The part of a `pg.PoolClient` that the writer uses. */
export interface TimingClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
  release(err?: Error | boolean): void;
}

/** The part of a `pg.Pool` that the writer and the reader use. A `pg.Pool` satisfies it. */
export interface TimingPool { connect(): Promise<TimingClient> }

function refuseInvalid(v: TimingVersion): void {
  for (const [name, ms] of [['epsilonMs', v.epsilonMs], ['deltaXMs', v.deltaXMs], ['tauMs', v.tauMs]] as const) {
    if (!Number.isInteger(ms) || ms < 0) throw new TimingVersionRefused('NOT_WHOLE_MS', `${name} = ${ms}`);
  }
  if (v.tauMs < v.epsilonMs + v.deltaXMs) {
    throw new TimingVersionRefused('TAU_BELOW_EPSILON_PLUS_DELTA_X', `tau ${v.tauMs} < ${v.epsilonMs} + ${v.deltaXMs}`);
  }
  // RFC-006 §6.4: τ = max(ack_budget, ε + δ_x); a τ below ack_budget puts the fence after D − ack_budget (POL-26).
  if (v.tauMs < TIMING.ackBudgetMs) throw new TimingVersionRefused('TAU_BELOW_ACK_BUDGET', `tau ${v.tauMs} < ${TIMING.ackBudgetMs}`);
  if (v.tauMs > TIMING.tauCapMs) throw new TimingVersionRefused('TAU_ABOVE_CAP', `tau ${v.tauMs} > ${TIMING.tauCapMs}`);
}

function bigintOf(x: unknown): bigint {
  if (typeof x === 'bigint') return x;
  if (typeof x === 'string' || typeof x === 'number') return BigInt(x);
  throw new TypeError(`not an integer: ${String(x)}`);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Placement's writer (RFC-006 §6.4, §3.2). In one transaction it reads the highest version over the 64 shards
 * and sets every shard to that version + 1 with the new values. Refuses (TimingVersionRefused) before any
 * database access a version with τ < ε + δ_x, τ < ack_budget, τ above the cap, or a value that is not a whole
 * number of ms. Returns the new version.
 */
export async function writeTimingVersion(pool: TimingPool, v: TimingVersion): Promise<bigint> {
  refuseInvalid(v);
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    try {
      const head = (await client.query('SELECT max(version) AS v, count(*) AS n FROM platform_timing')).rows[0];
      const n = isRecord(head) ? Number(head['n']) : 0;
      if (!isRecord(head) || n !== PARAMS.timingShards) {
        throw new TimingVersionRefused('SHARDS_MISSING', `platform_timing has ${n} shards, expected ${PARAMS.timingShards}`);
      }
      const next = bigintOf(head['v']) + 1n;
      const r = await client.query(
        'UPDATE platform_timing SET version = $1, epsilon_ms = $2, delta_x_ms = $3, tau_ms = $4, second_lane = $5::JSONB',
        [next.toString(), v.epsilonMs, v.deltaXMs, v.tauMs, JSON.stringify(v.secondLane)]);
      if (r.rowCount !== PARAMS.timingShards) {
        throw new TimingVersionRefused('SHARDS_MISSING', `updated ${String(r.rowCount)} shards, expected ${PARAMS.timingShards}`);
      }
      await client.query('COMMIT');
      return next;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => { broken = true; });
      throw e;
    }
  } finally {
    client.release(broken);
  }
}

function secondLaneOf(x: unknown): SecondLaneSettings {
  const raw: unknown = typeof x === 'string' ? JSON.parse(x) : x;
  const out: SecondLaneSettings = {};
  if (!isRecord(raw)) return out;
  for (const [kind, lanes] of Object.entries(raw)) {
    if (!isRecord(lanes)) continue;
    const s: { account?: boolean; deadline?: boolean } = {};
    if (typeof lanes['account'] === 'boolean') s.account = lanes['account'];
    if (typeof lanes['deadline'] === 'boolean') s.deadline = lanes['deadline'];
    out[kind] = s;
  }
  return out;
}

/** Reads the timing version of one shard, with its lane settings (C01 §2.3). Throws when the shard has no row. */
export async function readTimingVersion(pool: TimingPool, shard: number): Promise<TimingSnapshot & { secondLane: SecondLaneSettings }> {
  const client = await pool.connect();
  try {
    const r = (await client.query(
      'SELECT version, epsilon_ms, delta_x_ms, tau_ms, second_lane FROM platform_timing WHERE shard = $1', [shard])).rows[0];
    if (!isRecord(r)) throw new Error(`platform_timing has no row for shard ${shard}`);
    return { version: bigintOf(r['version']), epsilonMs: Number(r['epsilon_ms']), deltaXMs: Number(r['delta_x_ms']),
      tauMs: Number(r['tau_ms']), secondLane: secondLaneOf(r['second_lane']) };
  } finally {
    client.release();
  }
}

// ---------- alarms (RFC-006 §6.5) ----------

/** The timing alarms of RFC-006 §6.5. */
export type TimingAlarmId = 'A-T1' | 'A-T2' | 'A-T3' | 'A-T4' | 'A-T5';

/** One raised timing alarm. `toOperationalAlert` maps it to C01 §2.10. */
export interface TimingAlert { alarm: TimingAlarmId; severity: 'warning' | 'page'; detail: Record<string, string | number> }

/** An offset ladder level (RFC-006 §6.3). Levels A, D and T raise A-T5. */
export type OffsetLevel = 'normal' | 'W' | 'A' | 'D' | 'T';

const LEVEL_RANK: Record<OffsetLevel, number> = { normal: 0, W: 1, A: 2, D: 3, T: 4 };
const MINUTE_MS = 60_000;

function ceilTo(ms: number, step: number): number {
  return Math.ceil(ms / step) * step;
}

/** p99.9 by the nearest-rank method: the value at rank ceil(0.999 × n) of the sorted samples. */
function p999(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.999 * sorted.length) - 1];
}

/**
 * The timing alarms (RFC-006 §6.5), pure: the caller gives the samples and calls `evaluate`. Time comes only
 * from the injected `wallMs`.
 *
 * Episode rule: an alarm is raised once when its condition starts to hold (after its hold time, for A-T1 and
 * A-T2) and is not raised again until `evaluate` sees the condition false. A-T4 has one episode per wall-clock
 * minute that has a late release, raised at the first `evaluate` after that minute ends. The conditions are
 * checked only at `evaluate`; "continuously" means true at every `evaluate` since the start of the period.
 * `newVersion` is level-triggered: it is given at every `evaluate` while the action is due, so a failed write
 * is tried again; it ends when the caller writes it and gives it as `current`.
 */
export class TimingAlarms {
  private readonly wallMs: WallClock;
  private readonly samples = new Map<string, Array<{ atMs: number; ms: number }>>();
  private readonly levels = new Map<string, OffsetLevel>();
  private readonly lateByMinute = new Map<number, number>();
  private at1Since: number | undefined;
  private at2Since: number | undefined;
  private readonly raised = new Set<'A-T1' | 'A-T2' | 'A-T3' | 'A-T5'>();

  constructor(o: { wallMs?: WallClock } = {}) {
    this.wallMs = o.wallMs ?? systemClock;
  }

  /** Records one δ_x sample in ms for a topology state: a timing probe round trip, or an expiry → release that an owner measured. */
  recordDeltaX(sampleMs: number, state = 'steady'): void {
    if (!Number.isFinite(sampleMs) || sampleMs < 0) throw new RangeError(`delta x sample must be finite and >= 0: ${sampleMs}`);
    const list = this.samples.get(state) ?? [];
    list.push({ atMs: this.wallMs(), ms: sampleMs });
    this.samples.set(state, list);
  }

  /** Records the latest offset ladder level of one source (a database node, an owner host, or the cluster). */
  recordOffsetLevel(level: OffsetLevel, source: string): void {
    this.levels.set(source, level);
  }

  /** Records one Share-link release for an expiry that became durable after `D` (RFC-006 §6.5 item 3). */
  recordLateRelease(requestHex: string): void {
    void requestHex; // RFC-006 §6.5: reported per request by the account owner (RFC-002); here only counted.
    const minute = Math.floor(this.wallMs() / MINUTE_MS);
    this.lateByMinute.set(minute, (this.lateByMinute.get(minute) ?? 0) + 1);
  }

  /** δ_x_meas: the p99.9 over the sliding 5-minute window of each topology state, and the maximum over the states. */
  measuredDeltaX(): { ms: number; state: string } | undefined {
    const now = this.wallMs();
    let best: { ms: number; state: string } | undefined;
    for (const [state, list] of this.samples) {
      const kept = list.filter((s) => now - s.atMs < TIMING.windowMs);
      if (kept.length === 0) { this.samples.delete(state); continue; }
      this.samples.set(state, kept);
      const v = p999(kept.map((s) => s.ms));
      if (v !== undefined && (best === undefined || v > best.ms)) best = { ms: v, state };
    }
    return best;
  }

  /** Evaluates every alarm against the current version. Gives the alerts raised now and, when an action is due, the next version. */
  evaluate(current: TimingVersion): { alerts: TimingAlert[]; newVersion?: TimingVersion } {
    const now = this.wallMs();
    const alerts: TimingAlert[] = [];
    let newVersion: TimingVersion | undefined;
    const meas = this.measuredDeltaX();

    // A-T1: ε_cfg + δ_x_meas > τ_cfg − 30 ms for 5 min. Warning, no action.
    const at1 = meas !== undefined && current.epsilonMs + meas.ms > current.tauMs - TIMING.at1MarginMs;
    this.at1Since = at1 ? (this.at1Since ?? now) : undefined;
    if (meas !== undefined && this.at1Since !== undefined && now - this.at1Since >= TIMING.at1HoldMs) {
      this.raiseOnce('A-T1', alerts, { alarm: 'A-T1', severity: 'warning', detail: {
        epsilonMs: current.epsilonMs, deltaXMeasMs: meas.ms, tauMs: current.tauMs, marginMs: TIMING.at1MarginMs, state: meas.state } });
    } else if (!at1) {
      this.raised.delete('A-T1');
    }

    // A-T2: δ_x_meas > δ_x_cfg for 1 min ⇒ fast attack. A-T3: that τ above the cap ⇒ the deadline lane instead.
    const at2 = meas !== undefined && meas.ms > current.deltaXMs;
    this.at2Since = at2 ? (this.at2Since ?? now) : undefined;
    if (meas !== undefined && this.at2Since !== undefined && now - this.at2Since >= TIMING.at2HoldMs) {
      const deltaX = Math.max(current.deltaXMs, ceilTo(meas.ms + TIMING.fastAttackMarginMs, TIMING.roundToMs));
      const tau = Math.max(current.tauMs, tauFor(current.epsilonMs, deltaX));
      if (tau <= TIMING.tauCapMs) {
        this.raised.delete('A-T3');
        this.raiseOnce('A-T2', alerts, { alarm: 'A-T2', severity: 'page', detail: {
          deltaXMeasMs: meas.ms, deltaXCfgMs: current.deltaXMs, newDeltaXCfgMs: deltaX, newTauMs: tau, state: meas.state } });
        newVersion = { ...current, deltaXMs: deltaX, tauMs: tau };
      } else {
        this.raised.delete('A-T2');
        this.raiseOnce('A-T3', alerts, { alarm: 'A-T3', severity: 'page', detail: {
          deltaXMeasMs: meas.ms, deltaXCfgMs: current.deltaXMs, wouldBeTauMs: tau, tauCapMs: TIMING.tauCapMs, state: meas.state } });
        // RFC-006 §6.4: τ is not raised beyond the cap; the deadline-entry lane goes on for account and link.
        // δ_x_cfg and τ_cfg stay as they are (the §6.4 values 235 ms / 335 ms are estimates, not a rule).
        const lane = withDeadlineLane(current.secondLane, ['account', 'link']);
        if (lane !== undefined) {
          newVersion = { ...current, deltaXMs: current.deltaXMs, tauMs: Math.min(current.tauMs, TIMING.tauCapMs), secondLane: lane };
        }
      }
    } else if (!at2) {
      this.raised.delete('A-T2');
      this.raised.delete('A-T3');
    }

    // A-T4: one page per wall-clock minute that had a late release, with the count.
    const thisMinute = Math.floor(now / MINUTE_MS);
    for (const [minute, count] of [...this.lateByMinute].sort((a, b) => a[0] - b[0])) {
      if (minute >= thisMinute) continue;
      alerts.push({ alarm: 'A-T4', severity: 'page', detail: { minute: new Date(minute * MINUTE_MS).toISOString(), count } });
      this.lateByMinute.delete(minute);
    }

    // A-T5: any offset at ladder level A or above.
    let worst: { level: OffsetLevel; source: string } | undefined;
    for (const [source, level] of [...this.levels].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      if (LEVEL_RANK[level] >= LEVEL_RANK.A && (worst === undefined || LEVEL_RANK[level] > LEVEL_RANK[worst.level])) worst = { level, source };
    }
    if (worst !== undefined) {
      this.raiseOnce('A-T5', alerts, { alarm: 'A-T5', severity: 'page', detail: { level: worst.level, source: worst.source } });
    } else {
      this.raised.delete('A-T5');
    }

    return newVersion === undefined ? { alerts } : { alerts, newVersion };
  }

  private raiseOnce(id: 'A-T1' | 'A-T2' | 'A-T3' | 'A-T5', alerts: TimingAlert[], a: TimingAlert): void {
    if (this.raised.has(id)) return;
    this.raised.add(id);
    alerts.push(a);
  }
}

/** The lane settings with `deadline: true` for the kinds, or undefined when every kind already has it. */
function withDeadlineLane(lanes: SecondLaneSettings, kinds: string[]): SecondLaneSettings | undefined {
  if (kinds.every((k) => lanes[k]?.deadline === true)) return undefined;
  const out: SecondLaneSettings = { ...lanes };
  for (const k of kinds) out[k] = { ...lanes[k], deadline: true };
  return out;
}

/**
 * Maps a timing alert to a raised C01 §2.10 OperationalAlert. The subject is the alarm id (the cell's timing);
 * the episode is the raising entry's (partition, seq) (R47-08). alertKind and reasonCode are the alarm id.
 */
export function toOperationalAlert(a: TimingAlert, at: { partition: Uint8Array; seq: Seq; raisedAt: HlcTs }): OperationalAlert {
  return {
    alertId: { partition: at.partition, alertKind: a.alarm, subject: new TextEncoder().encode(a.alarm), episode: { partition: at.partition, seq: at.seq } },
    op: 'raised', alertKind: a.alarm, severity: a.severity, entities: [], reasonCode: a.alarm, detail: a.detail, raisedAt: at.raisedAt,
  };
}

// ---------- timing probe (RFC-006 §6.5 item 1) ----------

/** One expiry-and-release round trip between a sample of account and link slots, done by those owners. */
export interface TimingRoundTripPort { roundTrip(): Promise<{ expiryTs: HlcTs; releaseTs: HlcTs }> }

/** Starts a repeating tick and gives a way to cancel it. */
export type TickScheduler = (fn: () => void, ms: number) => { cancel(): void };

const unrefInterval: TickScheduler = (fn, ms) => {
  const h = setInterval(fn, ms);
  h.unref();
  return { cancel: () => clearInterval(h) };
};

/**
 * The driver of the synthetic timing probes (RFC-006 §6.5): each run records δ_x = releaseTs − expiryTs (ms)
 * in a TimingAlarms under the current topology state. A failed round trip, or a release before its expiry,
 * is counted in `failures` and records nothing.
 */
export class TimingProbe {
  /** Round trips started. */
  runs = 0;
  /** Round trips that failed or gave a release before the expiry. */
  failures = 0;
  private readonly alarms: TimingAlarms;
  private readonly port: TimingRoundTripPort['roundTrip'];
  private readonly state: () => string;
  private readonly schedule: TickScheduler;
  private ticking: { cancel(): void } | undefined;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(o: { alarms: TimingAlarms; roundTrip: TimingRoundTripPort['roundTrip']; state?: () => string; schedule?: TickScheduler }) {
    this.alarms = o.alarms;
    this.port = o.roundTrip;
    this.state = o.state ?? (() => 'steady');
    this.schedule = o.schedule ?? unrefInterval;
  }

  /** Runs one round trip and records its δ_x. Never throws. */
  async runOnce(): Promise<void> {
    this.runs++;
    try {
      const { expiryTs, releaseTs } = await this.port();
      const ns = hlcParts(releaseTs).wallNs - hlcParts(expiryTs).wallNs;
      if (ns < 0n) { this.failures++; return; }
      this.alarms.recordDeltaX(Number(ns) / 1_000_000, this.state());
    } catch {
      this.failures++;
    }
  }

  /** Starts one round trip every `intervalMs` (default 1 s). A second start while running does nothing. */
  start(intervalMs = 1_000): void {
    if (this.ticking !== undefined) return;
    this.ticking = this.schedule(() => {
      const p = this.runOnce().finally(() => this.inFlight.delete(p));
      this.inFlight.add(p);
    }, intervalMs);
  }

  /** Stops the ticks. A round trip in flight completes. */
  stop(): void {
    this.ticking?.cancel();
    this.ticking = undefined;
  }

  /** Resolves when every round trip in flight has completed. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }
}
