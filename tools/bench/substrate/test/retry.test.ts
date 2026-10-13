import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { classifyFailure } from '../src/retry.ts';
import { CRDB_ABORT, CRDB_RESTART, dbError } from './support.ts';

describe('classifyFailure on CockroachDB', () => {
  it('should classify a 40001 retry error as a restart with its reason', () => {
    assert.deepEqual(classifyFailure(dbError('40001', CRDB_RESTART), 'crdb', 'statement'), { kind: 'restart', reason: 'RETRY_SERIALIZABLE' });
  });

  it('should name a write-too-old and an uncertainty restart', () => {
    assert.deepEqual(classifyFailure(dbError('40001', 'restart transaction: TransactionRetryWithProtoRefreshError: WriteTooOldError: write for key /Table/1 at timestamp 1 too old'), 'crdb', 'statement'),
      { kind: 'restart', reason: 'WriteTooOldError' });
    assert.deepEqual(classifyFailure(dbError('40001', 'restart transaction: TransactionRetryWithProtoRefreshError: ReadWithinUncertaintyIntervalError: read at time 1'), 'crdb', 'statement'),
      { kind: 'restart', reason: 'ReadWithinUncertaintyIntervalError' });
  });

  it('should classify a TransactionAbortedError apart from a restart (RFC-006 §4.3, R33-17)', () => {
    assert.deepEqual(classifyFailure(dbError('40001', CRDB_ABORT), 'crdb', 'statement'), { kind: 'abort', reason: 'ABORT_REASON_PUSHER_ABORTED' });
  });

  it('should keep an unknown 40001 text as a restart with reason unknown', () => {
    assert.deepEqual(classifyFailure(dbError('40001', 'restart transaction'), 'crdb', 'statement'), { kind: 'restart', reason: 'unknown' });
  });

  it('should classify a 40001 answer to RELEASE as a restart, not as ambiguous', () => {
    assert.deepEqual(classifyFailure(dbError('40001', CRDB_RESTART), 'crdb', 'commit'), { kind: 'restart', reason: 'RETRY_SERIALIZABLE' });
  });
});

describe('classifyFailure on YugabyteDB', () => {
  it('should classify every 40001 as an abort, because no restart keeps intents', () => {
    assert.deepEqual(classifyFailure(dbError('40001', 'Restart read required at: { read: 1 }'), 'yugabyte', 'statement'), { kind: 'abort', reason: 'read_restart' });
    assert.deepEqual(classifyFailure(dbError('40001', 'Operation failed. Try again: Transaction 1 conflicts with higher priority transaction: 2'), 'yugabyte', 'statement'),
      { kind: 'abort', reason: 'conflict' });
    assert.deepEqual(classifyFailure(dbError('40001', 'could not serialize access due to concurrent update'), 'yugabyte', 'statement'), { kind: 'abort', reason: 'serialization' });
    assert.deepEqual(classifyFailure(dbError('40001', 'Transaction aborted: kAborted'), 'yugabyte', 'commit'), { kind: 'abort', reason: 'aborted' });
    assert.deepEqual(classifyFailure(dbError('40001', 'something new'), 'yugabyte', 'statement'), { kind: 'abort', reason: 'unknown' });
  });
});

describe('classifyFailure on both flavours', () => {
  for (const flavour of ['crdb', 'yugabyte'] as const) {
    it(`should classify a deadlock as an abort (${flavour})`, () => {
      assert.deepEqual(classifyFailure(dbError('40P01', 'deadlock detected'), flavour, 'statement'), { kind: 'abort', reason: 'deadlock' });
    });

    it(`should classify a lost COMMIT answer as ambiguous (${flavour})`, () => {
      assert.deepEqual(classifyFailure(dbError('40003', 'result is ambiguous'), flavour, 'commit'), { kind: 'ambiguous', reason: '40003' });
      assert.deepEqual(classifyFailure(dbError('57014', 'query execution canceled due to statement timeout'), flavour, 'commit'), { kind: 'ambiguous', reason: '57014' });
      assert.deepEqual(classifyFailure(dbError('08006', 'connection failure'), flavour, 'commit'), { kind: 'ambiguous', reason: '08006' });
      assert.deepEqual(classifyFailure(new Error('Connection terminated unexpectedly'), flavour, 'commit'), { kind: 'ambiguous', reason: 'connection' });
    });

    it(`should classify a statement timeout before COMMIT apart from other errors (${flavour})`, () => {
      assert.deepEqual(classifyFailure(dbError('57014', 'query execution canceled due to statement timeout'), flavour, 'statement'), { kind: 'statementTimeout' });
      assert.deepEqual(classifyFailure(new Error('Connection terminated unexpectedly'), flavour, 'statement'), { kind: 'other', code: 'connection' });
      assert.deepEqual(classifyFailure(dbError('23505', 'duplicate key value'), flavour, 'statement'), { kind: 'other', code: '23505' });
      assert.deepEqual(classifyFailure(dbError('23505', 'duplicate key value'), flavour, 'commit'), { kind: 'other', code: '23505' });
    });
  }
});
