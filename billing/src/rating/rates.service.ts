import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { Party } from '../domain/split';

export interface Rate {
  id: string;
  priceMicrosPerGb: bigint;
  parties: Party[];
}

@Injectable()
export class RatesService {
  /**
   * The rate in force at `at` (event time, D20): the latest effective_from at or
   * before `at`, and among those the highest version, so a corrected price
   * replaces a mistaken one without rewriting history.
   */
  async rateAt(c: PoolClient, routeId: string, at: Date): Promise<Rate> {
    const { rows } = await c.query<{ id: string; price: string }>(
      `SELECT id, price_micros_per_gb AS price FROM rates
        WHERE route_id = $1 AND effective_from <= $2
        ORDER BY effective_from DESC, version DESC LIMIT 1`,
      [routeId, at],
    );
    if (rows.length === 0) throw new Error(`no rate for route ${routeId} at ${at.toISOString()}`);
    const splits = await c.query<{ account: string; weight: number }>(
      `SELECT account, weight FROM rate_splits WHERE rate_id = $1`,
      [rows[0].id],
    );
    return { id: rows[0].id, priceMicrosPerGb: BigInt(rows[0].price), parties: splits.rows };
  }
}
