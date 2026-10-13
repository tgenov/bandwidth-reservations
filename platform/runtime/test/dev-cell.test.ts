import { test } from 'node:test';
import assert from 'node:assert/strict';
import { databaseUrl, devCellRequired, devCellSkip, staleTestDatabases, testDatabaseName } from '../testing/dev-cell.ts';

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

const NOW_MS = 1_791_878_186_248;
const HOUR_MS = 3_600_000;

test('should name a test database with the prefix, the time and the random suffix', () => {
  assert.equal(testDatabaseName('itest_link', NOW_MS, 'a1b2c3'), `itest_link_${NOW_MS}_a1b2c3`);
});

test('should reject a prefix that is not a plain lower-case identifier', () => {
  assert.throws(() => testDatabaseName('itest-link', NOW_MS, 'a1b2c3'), { message: 'test database prefix must match [a-z][a-z0-9_]*: itest-link' });
});

test('should drop only the databases with the prefix that are more than one hour old', () => {
  const names = [
    `itest_link_${NOW_MS - HOUR_MS - 1}_aaaaaa`,
    `itest_link_${NOW_MS - HOUR_MS}_bbbbbb`,
    `itest_link_${NOW_MS}_cccccc`,
    `itest_linkx_${NOW_MS - 2 * HOUR_MS}_dddddd`,
    `itest_rate_${NOW_MS - 2 * HOUR_MS}_eeeeee`,
    'defaultdb',
  ];
  assert.deepEqual(staleTestDatabases(names, 'itest_link', NOW_MS), [`itest_link_${NOW_MS - HOUR_MS - 1}_aaaaaa`]);
});

test('should put the database name in the connection string and keep its options', () => {
  assert.equal(databaseUrl('postgresql://root@localhost:26257/defaultdb?sslmode=disable', 'itest_link_1_a'),
    'postgresql://root@localhost:26257/itest_link_1_a?sslmode=disable');
});
