/** C06 reservation-batch suite (§7 posting acknowledgement, §8 posting port) against the real settlement and ledger (MONEY-I2). */
import { C06_SUITE_WEIGHTS, runC06ReservationSuite, type C06ReservationSubject } from '@share/contract-suites';
import { moneyWorld } from '../testing/index.ts';

runC06ReservationSuite('real ledger', async (): Promise<C06ReservationSubject> => {
  const w = await moneyWorld();
  w.weights.apply(C06_SUITE_WEIGHTS);
  return {
    settle: (batch) => w.settle(batch),
    post: async (req, account) => {
      const a = await w.post(account, req);
      if (a.result === 'routing') throw new Error(`routing refusal ${a.refusal.code}`);
      return a;
    },
    integrityAlerts: () => w.ledger.alerts.filter((a) => a.code === 'INTEGRITY_LINE_CONFLICT' || a.code === 'INTEGRITY_MOVEMENT_DIGEST').length,
    close: async () => {},
  };
});
