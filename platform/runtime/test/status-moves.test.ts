/**
 * S-PLAT-I3 work item 3: status readers and moves (C01 §2.4, §3.3; R47-17). A reader of A that applied `moved` answers
 * the partition by rule 4; a reader of B reads it at max(P_grant, adoptTs).
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { HlcTs, SlotNo } from '../src/index.ts';
import { NotClosed, StatusReader, ceilMicrosLiteral, hlc, utf8, type LeaseAnswer, type ReadLeaseHolder } from '../src/index.ts';
import type { ReaderChannel } from '../src/report/report.ts';

const X = utf8('acct-x');
const P_GRANT = hlc('1800000000000000000.0000000000');
const ADOPT = hlc('1800000000500000000.0000000003');
const T = { timeout: 5_000 };
let reader: StatusReader | undefined;
afterEach(() => { reader?.stop(); reader = undefined; });

function setup(): { reader: StatusReader; channel: () => ReaderChannel; sql: string[] } {
  let ch: ReaderChannel | undefined;
  const holder: ReadLeaseHolder = {
    grantReadLease: (): LeaseAnswer => ({ granted: true, pGrant: P_GRANT, reportPosition: P_GRANT, untilMonotonic: process.hrtime.bigint() + 10n ** 9n }),
    attachReader: (_id, c) => { ch = c; },
    detachReader: () => {},
  };
  const sql: string[] = [];
  const r = new StatusReader({ readerId: 'r1', kind: 'account', slotOf: (): SlotNo => 3, holderOf: () => holder,
    pool: { query: (async (q: string) => { sql.push(q); return { rows: [{ v: 1 }] }; }) as never } });
  r.renew(3);
  reader = r;
  return { reader: r, channel: () => { assert.ok(ch); return ch; }, sql };
}

test('C01 CP-5 a reader of A that applied moved answers the partition by rule 4 (isMovedOut, leasedRead throws NotClosed)', T, async () => {
  const { reader: r, channel } = setup();
  assert.equal(r.isMovedOut(X), false);
  channel().movedOut?.(3, X, P_GRANT);
  assert.equal(r.isMovedOut(X), true);
  assert.equal(r.isMovedOut(utf8('other')), false);
  await assert.rejects(r.leasedRead(X, [{ table: 'account_request', key: { account: X } }]), (e: unknown) => e instanceof NotClosed);
});

test('C01 CP-5 a reader of B reads an adopted partition at max(P_grant, adoptTs) (R47-17), and no longer by rule 4', T, async () => {
  const { reader: r, channel, sql } = setup();
  channel().movedOut?.(3, X, P_GRANT);
  channel().adopted?.(3, X, ADOPT);
  assert.equal(r.isMovedOut(X), false);
  assert.deepEqual(await r.leasedRead(X, [{ table: 'account_request', key: { account: X } }]), [{ v: 1 }]);
  assert.ok(sql[0]?.includes(`with_min_timestamp('${ceilMicrosLiteral(ADOPT)}'`), sql[0]);
  await r.leasedRead(utf8('plain'), [{ table: 'account_request', key: { account: X } }]);
  assert.ok(sql[1]?.includes(`with_min_timestamp('${ceilMicrosLiteral(P_GRANT as HlcTs)}'`), sql[1]);
});

test('should read an adopted partition at P_grant when adoptTs is below P_grant (R47-17)', T, async () => {
  const { reader: r, channel, sql } = setup();
  const EARLY = hlc('1799999999000000000.0000000000');
  channel().movedOut?.(3, X, EARLY);
  channel().adopted?.(3, X, EARLY);
  assert.deepEqual(await r.leasedRead(X, [{ table: 'account_request', key: { account: X } }]), [{ v: 1 }]);
  assert.equal(sql.length, 1);
  assert.ok(sql[0]?.includes(`with_min_timestamp('${ceilMicrosLiteral(P_GRANT)}'`), sql[0]);
  assert.equal(sql[0]?.includes(ceilMicrosLiteral(EARLY)), false);
});
