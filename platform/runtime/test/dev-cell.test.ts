import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devCellRequired, devCellSkip } from '../testing/dev-cell.ts';

const REQUIRED = { REQUIRE_DEV_CELL: '1' };
const LAPTOP = {};

test('should not skip when the dev cell is reachable', () => {
  assert.equal(devCellSkip(undefined, LAPTOP), false);
  assert.equal(devCellSkip(undefined, REQUIRED), false);
});

test('should skip with the reason when the dev cell is not reachable and not required', () => {
  assert.equal(devCellSkip('CockroachDB at x: ECONNREFUSED', LAPTOP),
    'dev cell not reachable: CockroachDB at x: ECONNREFUSED (run `npm run dev:up`)');
});

test('should throw when REQUIRE_DEV_CELL=1 and the dev cell is not reachable', () => {
  assert.throws(() => devCellSkip('CockroachDB at x: ECONNREFUSED', REQUIRED), {
    message: 'REQUIRE_DEV_CELL=1 and the dev cell not reachable: CockroachDB at x: ECONNREFUSED (run `npm run dev:up`)',
  });
});

test('should require the dev cell only when REQUIRE_DEV_CELL is exactly 1', () => {
  assert.equal(devCellRequired(REQUIRED), true);
  assert.equal(devCellRequired({ REQUIRE_DEV_CELL: '0' }), false);
  assert.equal(devCellRequired(LAPTOP), false);
});
