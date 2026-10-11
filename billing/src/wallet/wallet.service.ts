import { Injectable } from '@nestjs/common';
import { Db } from '../database/database.module';
import { ExposureService } from '../exposure/exposure.service';
import { CLEARING, LedgerService, wallet } from '../ledger/ledger.service';
import { PaymentEventDto } from './payment-event.dto';

@Injectable()
export class WalletService {
  constructor(
    private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly exposure: ExposureService,
  ) {}

  /**
   * Each (provider txn id, type) posts once, whatever the delivery pattern.
   * A reversal that overtakes its completion just posts first; the final
   * balance is the same either way, because the two journals commute.
   */
  async applyPaymentEvent(e: PaymentEventDto): Promise<'applied' | 'duplicate'> {
    const applied = await this.db.tx(async (c) => {
      const ins = await c.query(
        `INSERT INTO payment_events (provider_txn_id, type, customer_id, amount_micros, occurred_at)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [e.providerTxnId, e.type, e.customerId, e.amountMicros, e.occurredAt],
      );
      if (ins.rowCount === 0) return false;
      const amount = BigInt(e.amountMicros) * (e.type === 'completed' ? 1n : -1n);
      await this.ledger.post(c, {
        kind: 'topup',
        reference: `${e.providerTxnId}:${e.type}`,
        amounts: new Map([
          [wallet(e.customerId), amount],
          [CLEARING, -amount],
        ]),
      });
      return true;
    });
    if (!applied) return 'duplicate';
    await this.exposure.check(e.customerId); // a top-up can lift a suspension
    return 'applied';
  }

  async standing(customerId: string) {
    const s = await this.exposure.standing(customerId);
    return {
      customerId,
      balanceMicros: s.balance.toString(),
      exposureMicros: s.exposure.toString(),
      availableMicros: s.available.toString(),
    };
  }
}
