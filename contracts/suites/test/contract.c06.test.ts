/**
 * C06 settlement and ledger. The real provider runs runC06ReservationSuite (MONEY-I2) and runC06ProviderSuite
 * (MONEY-I3) in slices/account/money/test/contract.c06.test.ts. The settlement double of the rate slice runs
 * both suites in slices/rate/rating-owner/test/contract.c06.test.ts (S-RATE-I4). No C06 provider part is pending.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runC06ProviderSuite, runC06ReservationSuite } from '../src/index.ts';

test('should export the C06 provider suites that the real ledger and the rate slice double run', () => {
  assert.equal(typeof runC06ProviderSuite, 'function');
  assert.equal(typeof runC06ReservationSuite, 'function');
});
