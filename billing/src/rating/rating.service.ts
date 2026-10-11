import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { Db } from '../database/database.module';
import { chargeMicros } from '../domain/money';
import { split } from '../domain/split';
import { ExposureService } from '../exposure/exposure.service';
import { LedgerService, wallet } from '../ledger/ledger.service';
import { RatesService } from './rates.service';

export interface FlowRecord {
  exporterId: string;
  sequence: number;
  reservationId: string;
  bytes: number;
  eventTime: Date;
}

export type IngestResult = 'duplicate' | 'pending' | 'corrected';

const minuteOf = (t: Date) => new Date(Math.floor(t.getTime() / 60_000) * 60_000);

// Serialises everything that reads or charges one (reservation, minute).
const LOCK_MINUTE = `SELECT pg_advisory_xact_lock(hashtextextended($1 || '|' || $2::text, 0))`;

@Injectable()
export class RatingService {
  constructor(
    private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly rates: RatesService,
    private readonly exposure: ExposureService,
  ) {}

  /**
   * Stores one raw flow record (D18). Duplicates are dropped by id. A record for
   * a minute that is already charged triggers a correction straight away (D19);
   * otherwise it waits for the minute to be rated.
   */
  async ingest(r: FlowRecord): Promise<IngestResult> {
    const minute = minuteOf(r.eventTime);
    const result = await this.db.tx(async (c) => {
      const ins = await c.query(
        `INSERT INTO flow_records (exporter_id, sequence, reservation_id, bytes, event_time)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [r.exporterId, r.sequence, r.reservationId, r.bytes, r.eventTime],
      );
      if (ins.rowCount === 0) return 'duplicate' as const;

      // Take the minute lock before asking "is it rated?". Without it, rating
      // could sum the minute while this insert is uncommitted, and this record
      // would never be charged.
      await c.query(LOCK_MINUTE, [r.reservationId, minute]);
      const rated = await c.query(
        `SELECT 1 FROM minute_charges WHERE reservation_id = $1 AND minute = $2`,
        [r.reservationId, minute],
      );
      if (rated.rowCount === 0) return 'pending' as const;
      await this.rateMinute(c, r.reservationId, minute);
      return 'corrected' as const;
    });
    if (result === 'corrected') await this.exposure.checkReservation(r.reservationId);
    return result;
  }

  /** Charges every minute that has records and has fully passed `watermark`. */
  async rateUpTo(watermark: Date): Promise<number> {
    const { rows } = await this.db.query<{ reservation_id: string; minute: Date }>(
      `SELECT DISTINCT f.reservation_id, date_trunc('minute', f.event_time) AS minute
         FROM flow_records f
        WHERE date_trunc('minute', f.event_time) + interval '1 minute' <= $1
          AND NOT EXISTS (SELECT 1 FROM minute_charges m
                           WHERE m.reservation_id = f.reservation_id
                             AND m.minute = date_trunc('minute', f.event_time))
        ORDER BY 2, 1`,
      [watermark],
    );
    const touched = new Set<string>();
    for (const row of rows) {
      const charged = await this.db.tx(async (c) => {
        await c.query(LOCK_MINUTE, [row.reservation_id, row.minute]);
        const ins = await c.query(
          `INSERT INTO minute_charges (reservation_id, minute) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [row.reservation_id, row.minute],
        );
        if (ins.rowCount === 0) return false; // rated concurrently
        await this.rateMinute(c, row.reservation_id, row.minute);
        return true;
      });
      if (charged) touched.add(row.reservation_id);
    }
    for (const id of touched) await this.exposure.checkReservation(id);
    return rows.length;
  }

  /** Re-rates charged minutes in [from, to) on a route, e.g. after a price correction. */
  async rerate(routeId: string, from: Date, to: Date): Promise<void> {
    const { rows } = await this.db.query<{ reservation_id: string; minute: Date }>(
      `SELECT m.reservation_id, m.minute FROM minute_charges m
         JOIN reservations r ON r.id = m.reservation_id
        WHERE r.route_id = $1 AND m.minute >= $2 AND m.minute < $3
        ORDER BY m.minute, m.reservation_id`,
      [routeId, from, to],
    );
    for (const row of rows) {
      await this.db.tx(async (c) => {
        await c.query(LOCK_MINUTE, [row.reservation_id, row.minute]);
        await this.rateMinute(c, row.reservation_id, row.minute);
      });
    }
  }

  /**
   * Brings the ledger for one (reservation, minute) to its target. The target
   * is computed from the minute's TOTAL bytes and split once; what is posted is
   * the difference from what earlier journals already posted for that minute.
   * So every account ends at split(total), whatever order records arrived in.
   * Caller holds the minute lock.
   */
  private async rateMinute(c: PoolClient, reservationId: string, minute: Date): Promise<void> {
    const res = await c.query<{ customer_id: string; route_id: string }>(
      `SELECT customer_id, route_id FROM reservations WHERE id = $1`,
      [reservationId],
    );
    const { customer_id, route_id } = res.rows[0];
    const usage = await c.query<{ bytes: string }>(
      `SELECT COALESCE(SUM(bytes), 0) AS bytes FROM flow_records
        WHERE reservation_id = $1 AND event_time >= $2 AND event_time < $2 + interval '1 minute'`,
      [reservationId, minute],
    );
    // Priced at the minute's start, so a late record uses the rate of its own time.
    const rate = await this.rates.rateAt(c, route_id, minute);
    const total = chargeMicros(BigInt(usage.rows[0].bytes), rate.priceMicrosPerGb);

    const target = split(total, rate.parties);
    target.set(wallet(customer_id), -total);

    const posted = await c.query<{ account: string; amount: string }>(
      `SELECT e.account, SUM(e.amount) AS amount
         FROM journals j JOIN entries e ON e.journal_id = j.id
        WHERE j.reservation_id = $1 AND j.minute = $2
        GROUP BY e.account`,
      [reservationId, minute],
    );
    const delta = new Map(target);
    for (const p of posted.rows) {
      delta.set(p.account, (delta.get(p.account) ?? 0n) - BigInt(p.amount));
    }
    await this.ledger.post(c, {
      kind: posted.rowCount === 0 ? 'charge' : 'correction',
      reservationId,
      minute,
      amounts: delta,
    });
  }
}
