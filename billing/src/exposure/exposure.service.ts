import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { billingConfig } from '../billing.config';
import { Db } from '../database/database.module';
import { bytesAtRate, chargeMicros } from '../domain/money';
import { LedgerService, wallet } from '../ledger/ledger.service';
import { BILLING_EVENTS, EventPublisher, TOPICS } from './events';

export interface Standing {
  balance: bigint;
  /** Most the customer can owe beyond what is charged: price × rate × lag (D19). */
  exposure: bigint;
  /** Headroom under the policy. At or below zero the customer is suspended. */
  available: bigint;
}

/**
 * The mechanism is fixed; the policy is configuration (D15, D19):
 *   reserve:      available = balance − exposure   (never ends below zero)
 *   credit_limit: available = balance + limit      (known worst-case loss)
 */
@Injectable()
export class ExposureService {
  constructor(
    private readonly db: Db,
    private readonly ledger: LedgerService,
    @Inject(billingConfig.KEY) private readonly cfg: ConfigType<typeof billingConfig>,
    @Inject(BILLING_EVENTS) private readonly events: EventPublisher,
  ) {}

  /** Exposure of one reservation at today's price for its route. */
  private async reservationExposure(routeId: string, reservedMbps: number): Promise<bigint> {
    const { rows } = await this.db.query<{ price: string }>(
      `SELECT price_micros_per_gb AS price FROM rates
        WHERE route_id = $1 AND effective_from <= now()
        ORDER BY effective_from DESC, version DESC LIMIT 1`,
      [routeId],
    );
    if (rows.length === 0) return 0n;
    const lag = this.cfg.meteringLagSeconds + this.cfg.enforcementLagSeconds;
    return chargeMicros(bytesAtRate(reservedMbps, lag), BigInt(rows[0].price));
  }

  async standing(customerId: string, extra?: { routeId: string; reservedMbps: number }) {
    const balance = await this.ledger.balance(wallet(customerId));
    const { rows } = await this.db.query<{ route_id: string; reserved_mbps: number }>(
      `SELECT route_id, reserved_mbps FROM reservations WHERE customer_id = $1`,
      [customerId],
    );
    const all = extra ? [...rows, { route_id: extra.routeId, reserved_mbps: extra.reservedMbps }] : rows;
    let exposure = 0n;
    for (const r of all) exposure += await this.reservationExposure(r.route_id, r.reserved_mbps);
    const available =
      this.cfg.exposurePolicy === 'reserve' ? balance - exposure : balance + this.cfg.creditLimitMicros;
    return { balance, exposure, available } satisfies Standing;
  }

  /** May this customer take on another reservation? Same rule, with it included. */
  async canAdmit(customerId: string, routeId: string, reservedMbps: number) {
    const s = await this.standing(customerId, { routeId, reservedMbps });
    return { allowed: s.available > 0n, ...s };
  }

  async checkReservation(reservationId: string): Promise<void> {
    const { rows } = await this.db.query<{ customer_id: string }>(
      `SELECT customer_id FROM reservations WHERE id = $1`,
      [reservationId],
    );
    if (rows.length > 0) await this.check(rows[0].customer_id);
  }

  /** Suspends or resumes the customer, emitting each transition exactly once. */
  async check(customerId: string): Promise<'suspended' | 'resumed' | 'unchanged'> {
    const s = await this.standing(customerId);
    if (s.available <= 0n) {
      const ins = await this.db.query(
        `INSERT INTO suspensions (customer_id, reason) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [customerId, `available ${s.available} under ${this.cfg.exposurePolicy}`],
      );
      if (ins.rowCount === 0) return 'unchanged';
      await this.events.emit(TOPICS.suspend, { customerId, available: s.available.toString() });
      return 'suspended';
    }
    const del = await this.db.query(`DELETE FROM suspensions WHERE customer_id = $1`, [customerId]);
    if (del.rowCount === 0) return 'unchanged';
    await this.events.emit(TOPICS.resume, { customerId, available: s.available.toString() });
    return 'resumed';
  }
}
