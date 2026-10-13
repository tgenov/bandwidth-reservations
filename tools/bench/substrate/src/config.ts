/** The generator's settings, read from SUBSTRATE_* environment variables (README.md lists them). */
export type Flavour = 'crdb' | 'yugabyte';
export type Mode = 'setup' | 'run' | 'merge';
export type StmtMode = 'per-row' | 'multi-row';

export interface SubstrateConfig {
  mode: Mode;
  flavour: Flavour;
  url: string;
  /** Free text that names the cluster layout, for example "2+2+1 gcp me-west1/me-central1/europe-west1". */
  topology: string;
  /** Free text that names the run in the matrix, for example "M2-steady". */
  label: string;
  processId: string;
  /** Slots of the kind (power of two). */
  slots: number;
  /** The slots this process drives: [slotFirst, slotFirst + slotCount). */
  slotFirst: number;
  slotCount: number;
  partitionsPerSlot: number;
  /** Offered calls a second for this process (open loop, Poisson). */
  ratePerS: number;
  durationS: number;
  warmupS: number;
  drainS: number;
  entriesPerCall: number;
  maxBatchEntries: number;
  maxBatchBytes: number;
  logBytes: number;
  outboxBytes: number;
  projectionBytes: number;
  stmtMode: StmtMode;
  timingRead: boolean;
  /** Every Nth batch of a slot carries a report marker (0: never). */
  markerEvery: number;
  batchRetries: number;
  abandonBeforeCommitMs: number;
  commitBackstopMs: number;
  statementTimeoutMs: number;
  idleInTransactionMs: number;
  poolSize: number;
  seed: number;
  dbMetrics: boolean;
  out: string | null;
  inputs: string[];
}

/** Every problem of an environment, listed at once. */
export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`bad substrate bench settings:\n  ${problems.join('\n  ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** RFC-006 §19.2: about 6.5 batches a second per account slot at the design load. */
const BATCHES_PER_SLOT_S = 6.5;
const URLS: Record<Flavour, string> = {
  crdb: 'postgresql://root@localhost:26257/substrate_bench?sslmode=disable',
  yugabyte: 'postgresql://yugabyte@localhost:5433/substrate_bench',
};

/** Reads the settings from `env`. `host` is the default process id. Throws ConfigError. */
export function parseConfig(env: Record<string, string | undefined>, host: string): SubstrateConfig {
  const problems: string[] = [];
  const raw = (k: string): string | undefined => {
    const v = env[`SUBSTRATE_${k}`];
    return v === undefined || v.trim() === '' ? undefined : v.trim();
  };
  function oneOf<T extends string>(k: string, allowed: readonly T[], dflt: T): T {
    const v = raw(k);
    if (v === undefined) return dflt;
    if ((allowed as readonly string[]).includes(v)) return v as T;
    problems.push(`SUBSTRATE_${k} must be one of ${allowed.join(', ')} (got ${v})`);
    return dflt;
  }
  const flag = (k: string, dflt: boolean): boolean => {
    const v = raw(k);
    if (v === undefined) return dflt;
    if (v === '0' || v === '1') return v === '1';
    problems.push(`SUBSTRATE_${k} must be 0 or 1 (got ${v})`);
    return dflt;
  };
  const int = (k: string, dflt: number, min = 1): number => {
    const v = raw(k);
    if (v === undefined) return dflt;
    const n = Number(v);
    if (Number.isInteger(n) && n >= min) return n;
    problems.push(`SUBSTRATE_${k} must be ${min === 0 ? 'an integer of 0 or more' : 'a positive integer'} (got ${v})`);
    return dflt;
  };

  const mode = oneOf<Mode>('MODE', ['setup', 'run', 'merge'], 'run');
  const flavour = oneOf<Flavour>('FLAVOUR', ['crdb', 'yugabyte'], 'crdb');
  const stmtMode = oneOf<StmtMode>('STMT_MODE', ['per-row', 'multi-row'], 'per-row');
  const timingRead = flag('TIMING_READ', true);
  const dbMetricsSet = raw('DB_METRICS') !== undefined;
  const dbMetrics = flag('DB_METRICS', flavour === 'crdb');

  const slots = int('SLOTS', 1024);
  const slotFirst = int('SLOT_FIRST', 0, 0);
  const slotCount = int('SLOT_COUNT', Math.max(1, slots - slotFirst));
  const partitionsPerSlot = int('PARTITIONS_PER_SLOT', 64);
  const durationS = int('DURATION_S', 120);
  const warmupS = int('WARMUP_S', 30, 0);
  const drainS = int('DRAIN_S', 15, 0);
  const entriesPerCall = int('ENTRIES_PER_CALL', 1);
  const maxBatchEntries = int('MAX_BATCH_ENTRIES', 2000);
  const maxBatchBytes = int('MAX_BATCH_BYTES', 4_194_304);
  const logBytes = int('LOG_BYTES', 200);
  const outboxBytes = int('OUTBOX_BYTES', 200);
  const projectionBytes = int('PROJECTION_BYTES', 100);
  const markerEvery = int('MARKER_EVERY', 0, 0);
  const batchRetries = int('BATCH_RETRIES', 5, 0);
  const abandonBeforeCommitMs = int('ABANDON_MS', 2000);
  const commitBackstopMs = int('COMMIT_BACKSTOP_MS', 15_000);
  const statementTimeoutMs = int('STATEMENT_TIMEOUT_MS', 2000);
  const idleInTransactionMs = int('IDLE_IN_TXN_MS', 1000);
  const poolSize = int('POOL_SIZE', slotCount);
  const seed = int('SEED', 1, 0);

  let ratePerS = BATCHES_PER_SLOT_S * slotCount;
  const rateRaw = raw('RATE');
  if (rateRaw !== undefined) {
    const r = Number(rateRaw);
    if (Number.isFinite(r) && r > 0) ratePerS = r;
    else problems.push(`SUBSTRATE_RATE must be a positive number (got ${rateRaw})`);
  }

  // home_key = reverse20(home) puts a slot's homes in one key range only for a power-of-two slot count (RFC-006 §3.7).
  if (!(slots <= 2 ** 20 && (slots & (slots - 1)) === 0)) problems.push(`SUBSTRATE_SLOTS must be a power of two from 1 to 1048576 (got ${slots})`);
  else if (slotFirst + slotCount > slots) {
    problems.push(`SUBSTRATE_SLOT_FIRST + SUBSTRATE_SLOT_COUNT must be at most SUBSTRATE_SLOTS (${slotFirst} + ${slotCount} > ${slots})`);
  }
  if (warmupS >= durationS) problems.push(`SUBSTRATE_WARMUP_S must be less than SUBSTRATE_DURATION_S (${warmupS} >= ${durationS})`);
  if (dbMetricsSet && dbMetrics && flavour !== 'crdb') problems.push('SUBSTRATE_DB_METRICS=1 needs SUBSTRATE_FLAVOUR=crdb (it reads crdb_internal.kv_node_status)');
  const inputs = (raw('INPUTS') ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (mode === 'merge' && inputs.length === 0) problems.push('SUBSTRATE_INPUTS must name at least one result file in merge mode');
  if (problems.length > 0) throw new ConfigError(problems);

  const topology = raw('TOPOLOGY') ?? 'unlabelled';
  return {
    mode, flavour, url: raw('URL') ?? URLS[flavour], topology, label: raw('LABEL') ?? topology, processId: raw('PROCESS') ?? host,
    slots, slotFirst, slotCount, partitionsPerSlot, ratePerS, durationS, warmupS, drainS,
    entriesPerCall, maxBatchEntries, maxBatchBytes, logBytes, outboxBytes, projectionBytes,
    stmtMode, timingRead, markerEvery,
    batchRetries, abandonBeforeCommitMs, commitBackstopMs, statementTimeoutMs, idleInTransactionMs,
    poolSize, seed, dbMetrics, out: raw('OUT') ?? null, inputs,
  };
}
