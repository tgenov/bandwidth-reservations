import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { Db } from '../database/database.module';

export type JournalKind = 'charge' | 'correction' | 'topup' | 'payout';

export interface JournalInput {
  kind: JournalKind;
  reservationId?: string;
  minute?: Date;
  reference?: string;
  /** Signed amounts per account; must sum to zero. Zero amounts are dropped. */
  amounts: Map<string, bigint>;
}

export const wallet = (customerId: string) => `wallet:${customerId}`;
export const CLEARING = 'clearing';

@Injectable()
export class LedgerService {
  constructor(private readonly db: Db) {}

  /**
   * Appends one journal inside the caller's transaction. The deferred trigger
   * re-checks the balance at COMMIT, so a bug here cannot persist unbalanced books.
   */
  async post(c: PoolClient, j: JournalInput): Promise<bigint | null> {
    const lines = [...j.amounts].filter(([, a]) => a !== 0n);
    if (lines.length === 0) return null;
    const sum = lines.reduce((s, [, a]) => s + a, 0n);
    if (sum !== 0n) throw new Error(`unbalanced journal: sums to ${sum}`);

    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO journals (kind, reservation_id, minute, reference)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [j.kind, j.reservationId ?? null, j.minute ?? null, j.reference ?? null],
    );
    const id = BigInt(rows[0].id);
    await c.query(
      `INSERT INTO entries (journal_id, account, amount)
       SELECT $1::bigint, acc, amt FROM unnest($2::text[], $3::bigint[]) AS t(acc, amt)`,
      [id.toString(), lines.map(([acc]) => acc), lines.map(([, a]) => a.toString())],
    );
    return id;
  }

  async balance(account: string, c?: PoolClient): Promise<bigint> {
    const q = `SELECT COALESCE(SUM(amount), 0) AS b FROM entries WHERE account = $1`;
    const { rows } = c ? await c.query<{ b: string }>(q, [account]) : await this.db.query<{ b: string }>(q, [account]);
    return BigInt(rows[0].b);
  }

  async balances(): Promise<Map<string, bigint>> {
    const { rows } = await this.db.query<{ account: string; b: string }>(
      `SELECT account, SUM(amount) AS b FROM entries GROUP BY account ORDER BY account`,
    );
    return new Map(rows.map((r) => [r.account, BigInt(r.b)]));
  }

  /**
   * Pays every supplier with a positive balance. A negative balance (after a
   * clawback) is simply not paid; later earnings net against it (D20).
   */
  async payoutRun(): Promise<Map<string, bigint>> {
    return this.db.tx(async (c) => {
      // One payout run at a time; charges may keep posting concurrently.
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('payout-run'))`);
      const { rows } = await c.query<{ account: string; b: string }>(
        `SELECT account, SUM(amount) AS b FROM entries
          WHERE account LIKE 'supplier:%' GROUP BY account HAVING SUM(amount) > 0
          ORDER BY account`,
      );
      const paid = new Map<string, bigint>();
      for (const r of rows) {
        const amount = BigInt(r.b);
        await this.post(c, {
          kind: 'payout',
          reference: r.account,
          amounts: new Map([
            [r.account, -amount],
            [CLEARING, amount],
          ]),
        });
        paid.set(r.account, amount);
      }
      return paid;
    });
  }
}
