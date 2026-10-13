/**
 * The batch transaction on a real database through `pg`: the statements of RFC-006 §4.3, in the order and form of
 * platform/runtime/src/store/pg.ts (PgBatchTxn: beginBatch, readFence, readTiming, readHeads, readRows, readTs,
 * write, commit, restart). Not unit-tested: it needs a database. The pure parts it uses (sql.ts, plan.ts,
 * protocol.ts) are.
 */
import type pg from 'pg';
import type { SubstrateConfig } from './config.ts';
import type { Call } from './lane.ts';
import { planWrites, partitionKey, type HeadState } from './plan.ts';
import { StaleEpoch, type TxnPort, type TxnSource } from './protocol.ts';
import { readStatements, writeStatements, type Dialect, type Stmt } from './sql.ts';

/** Statements sent by one batch, over all its attempts. */
export interface StatementCount {
  all: number;
  data: number;
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/** A COMMIT that the backstop timer ended: ambiguous (C01 §3.2, M1). */
function backstopError(ms: number): Error & { code: string } {
  return Object.assign(new Error(`COMMIT backstop ${ms} ms expired`), { code: 'backstop' });
}

/** Opens the batch transactions of one batch of one slot. */
export class PgTxnSource implements TxnSource {
  private readonly pool: pg.Pool;
  private readonly d: Dialect;
  private readonly cfg: SubstrateConfig;
  private readonly b: { slot: number; epoch: bigint; calls: Call[]; filler: Uint8Array; batchId: Uint8Array; markerSeq: bigint | null };
  readonly count: StatementCount = { all: 0, data: 0 };

  constructor(pool: pg.Pool, d: Dialect, cfg: SubstrateConfig, b: PgTxnSource['b']) {
    this.pool = pool;
    this.d = d;
    this.cfg = cfg;
    this.b = b;
  }

  async open(): Promise<TxnPort> {
    const client = await this.pool.connect();
    try {
      for (const s of this.d.begin) await this.q(client, { text: s, values: [] }, false);
    } catch (e) {
      client.release(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
    return {
      attempt: () => this.attempt(client),
      commit: () => this.commit(client),
      restart: async () => {
        if (this.d.restart === null) throw new Error('no restart statement on this database');
        await this.q(client, { text: this.d.restart, values: [] }, false);
      },
      rollback: async () => { await this.q(client, { text: 'ROLLBACK', values: [] }, false); },
      close: (broken) => { client.release(broken ? new Error('discarded after an unknown outcome') : undefined); },
    };
  }

  private async q(client: pg.PoolClient, s: Stmt, data: boolean): Promise<pg.QueryResult> {
    this.count.all += 1;
    if (data) this.count.data += 1;
    return client.query(s.text, s.values);
  }

  private async attempt(client: pg.PoolClient): Promise<void> {
    const { slot, epoch, calls } = this.b;
    const r = readStatements(this.d, { slot, slots: this.cfg.slots, timingRead: this.cfg.timingRead, calls });
    const fence = await this.q(client, r.fence, true);
    if (String(fence.rows[0]?.['epoch']) !== epoch.toString()) throw new StaleEpoch(slot);
    if (r.timing) await this.q(client, r.timing, true);
    const heads = await this.q(client, r.heads, true);
    const index = new Map(calls.map((c) => [hex(partitionKey(slot, c.partition)), c.partition]));
    const state = new Map<number, HeadState>();
    for (const row of heads.rows as Array<Record<string, unknown>>) {
      const p = index.get(hex(row['partition'] as Uint8Array));
      if (p === undefined) continue;
      const streams = JSON.parse(Buffer.from(row['streams'] as Uint8Array).toString('utf8')) as Record<string, string>;
      state.set(p, { seq: BigInt(String(row['seq'])), chain: new Uint8Array(row['chain'] as Uint8Array), streamSeq: BigInt(streams['outcome'] ?? '0') });
    }
    // The condition rows: a found row would answer that call ConditionFailed; request ids are new, so none is found.
    await this.q(client, r.conditions, true);
    const ts = String((await this.q(client, r.ts, true)).rows[0]?.['ts']);
    const writes = planWrites({
      slot, slots: this.cfg.slots, epoch, ts, batchId: this.b.batchId, calls, heads: state, filler: this.b.filler,
      sizes: this.cfg, marker: this.b.markerSeq === null ? null : { markerSeq: this.b.markerSeq },
    });
    for (const s of writeStatements(this.d, writes, slot, this.cfg.stmtMode)) await this.q(client, s, true);
  }

  private async commit(client: pg.PoolClient): Promise<void> {
    // COMMIT is exempt from the 2 s statement timeout; the backstop answers Ambiguous (platform/runtime/src/batch/execute.ts).
    const ms = this.cfg.commitBackstopMs;
    let timer: NodeJS.Timeout | undefined;
    const backstop = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(backstopError(ms)), ms + 250); });
    const work = (async () => { for (const s of this.d.commit(ms)) await this.q(client, { text: s, values: [] }, false); })();
    work.catch(() => undefined);       // after a backstop the late answer is not used; the connection is discarded
    try {
      await Promise.race([work, backstop]);
    } finally {
      clearTimeout(timer);
    }
  }
}
