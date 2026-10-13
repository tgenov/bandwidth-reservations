/**
 * C06 provider suites (§7 posting acknowledgement, §8 ledger posting port) against the real settlement and ledger:
 * reservation batches (MONEY-I2) and usage batches (MONEY-I3).
 */
import {
  C06_SUITE_WEIGHTS, runC06ProviderSuite, runC06ReservationSuite, type C06ReservationSubject, type C06Subject,
} from '@share/contract-suites';
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

/**
 * The usage suite posts each charge wholly to the one supplier of its route. C06 §2 needs a positive commission
 * weight, so the route has commission weight 1 against a supplier weight of 10⁹: the Webster split of every amount
 * of the suite (below 5 × 10⁸) gives the commission 0 (contracts/suites/ISSUES.md CS-9).
 */
const USAGE_SUITE_WEIGHTS = {
  entityType: 'split_weights' as const, route: 'route-u', weightsVersion: 'w-u', effectiveFrom: '2026-01-01T00:00:00Z', announcedAt: '0.0000000000',
  legs: [{ link: 'L1', supplier: 'sup-u', weight: 1_000_000_000 }], commissionWeight: 1,
};

runC06ProviderSuite('real ledger', async (): Promise<C06Subject> => {
  const w = await moneyWorld();
  w.weights.apply(USAGE_SUITE_WEIGHTS);
  return {
    settle: (batch) => w.settle(batch),
    post: async (req, account) => {
      const a = await w.post(account, req);
      if (a.result === 'routing') throw new Error(`routing refusal ${a.refusal.code}`);
      return a;
    },
    route: USAGE_SUITE_WEIGHTS.route, weightsVersion: USAGE_SUITE_WEIGHTS.weightsVersion, supplier: 'sup-u',
    integrityAlerts: () => w.ledger.alerts.filter((a) => a.code === 'INTEGRITY_LINE_CONFLICT' || a.code === 'INTEGRITY_MOVEMENT_DIGEST').length,
    close: async () => {},
  };
});
