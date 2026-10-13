import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { StaleEpoch, runProtocol, type ProtocolOptions, type TxnPort, type TxnSource } from '../src/protocol.ts';
import { CRDB_ABORT, CRDB_RESTART, ManualClock, dbError } from './support.ts';

type Step = () => void | Promise<void>;
const ok: Step = () => undefined;
const fail = (code: string, msg: string): Step => () => { throw dbError(code, msg); };

/** A scripted transaction source: each attempt and each commit takes the next step of its script; when a script ends, the step is ok. */
class ScriptedSource implements TxnSource {
  opened = 0;
  restarts = 0;
  rollbacks = 0;
  commits = 0;
  attempts = 0;
  closed: boolean[] = [];
  private readonly attemptSteps: Step[];
  private readonly commitSteps: Step[];

  constructor(attemptSteps: Step[], commitSteps: Step[] = []) {
    this.attemptSteps = attemptSteps;
    this.commitSteps = commitSteps;
  }

  async open(): Promise<TxnPort> {
    this.opened += 1;
    return {
      attempt: async () => { this.attempts += 1; await (this.attemptSteps.shift() ?? ok)(); },
      commit: async () => { this.commits += 1; await (this.commitSteps.shift() ?? ok)(); },
      restart: async () => { this.restarts += 1; },
      rollback: async () => { this.rollbacks += 1; },
      close: (broken) => { this.closed.push(broken); },
    };
  }
}

const opts = (clock: ManualClock, over: Partial<ProtocolOptions> = {}): ProtocolOptions =>
  ({ flavour: 'crdb', restartMode: 'savepoint', batchRetries: 5, abandonBeforeCommitMs: 2_000, clock, ...over });

describe('the client-side retry protocol (RFC-006 §4.3; platform/runtime/src/batch/execute.ts)', () => {
  it('should commit on the first attempt with no restart', async () => {
    const clock = new ManualClock(100);
    const src = new ScriptedSource([]);
    const r = await runProtocol(src, opts(clock));
    assert.deepEqual(r.outcome, { kind: 'committed' });
    assert.deepEqual([r.restarts, r.aborts, r.freshAttempts], [[], [], 0]);
    assert.deepEqual([src.opened, src.attempts, src.commits, src.restarts, src.rollbacks], [1, 1, 1, 0, 0]);
    assert.deepEqual(src.closed, [false]);
    assert.deepEqual([r.beganMs, r.commitStartMs, r.endMs], [100, 100, 100]);
  });

  it('should restart in the same transaction by the savepoint on a 40001 restart', async () => {
    const src = new ScriptedSource([fail('40001', CRDB_RESTART), fail('40001', CRDB_RESTART)]);
    const r = await runProtocol(src, opts(new ManualClock()));
    assert.deepEqual(r.outcome, { kind: 'committed' });
    assert.deepEqual(r.restarts, ['RETRY_SERIALIZABLE', 'RETRY_SERIALIZABLE']);
    assert.deepEqual([src.opened, src.restarts, src.attempts, src.rollbacks], [1, 2, 3, 0]);
  });

  it('should count an abort apart from a restart and retry it by the same path', async () => {
    const src = new ScriptedSource([fail('40001', CRDB_ABORT)]);
    const r = await runProtocol(src, opts(new ManualClock()));
    assert.deepEqual(r.outcome, { kind: 'committed' });
    assert.deepEqual([r.restarts, r.aborts], [[], ['ABORT_REASON_PUSHER_ABORTED']]);
    assert.equal(src.restarts, 1);
  });

  it('should restart when RELEASE answers 40001', async () => {
    const src = new ScriptedSource([], [fail('40001', CRDB_RESTART)]);
    const r = await runProtocol(src, opts(new ManualClock()));
    assert.deepEqual(r.outcome, { kind: 'committed' });
    assert.deepEqual([src.attempts, src.commits, src.restarts], [2, 2, 1]);
  });

  it('should start one fresh transaction after batchRetries restarts and then answer retry', async () => {
    const src = new ScriptedSource(Array.from({ length: 20 }, () => fail('40001', CRDB_RESTART)));
    const r = await runProtocol(src, opts(new ManualClock()));
    assert.deepEqual(r.outcome, { kind: 'retry' });
    assert.deepEqual([src.opened, src.restarts, src.attempts, src.commits], [2, 5, 7, 0]);
    assert.equal(r.restarts.length, 7);
    assert.equal(r.freshAttempts, 1);
    assert.deepEqual(src.closed, [false, false]);
  });

  it('should commit on the fresh attempt after batchRetries restarts', async () => {
    const src = new ScriptedSource(Array.from({ length: 4 }, () => fail('40001', CRDB_RESTART)));
    const r = await runProtocol(src, opts(new ManualClock(), { batchRetries: 3 }));
    assert.deepEqual(r.outcome, { kind: 'committed' });
    assert.deepEqual([src.opened, src.restarts, src.attempts], [2, 3, 5]);
  });

  it('should answer ambiguous at once when the COMMIT answer is lost, and discard the connection', async () => {
    const src = new ScriptedSource([], [fail('40003', 'result is ambiguous')]);
    const r = await runProtocol(src, opts(new ManualClock()));
    assert.deepEqual(r.outcome, { kind: 'ambiguous', reason: '40003' });
    assert.deepEqual([src.attempts, src.commits, src.restarts, src.rollbacks], [1, 1, 0, 0]);
    assert.deepEqual(src.closed, [true]);
  });

  it('should answer staleEpoch and roll back when the fence fails', async () => {
    const src = new ScriptedSource([() => { throw new StaleEpoch(7); }]);
    const r = await runProtocol(src, opts(new ManualClock()));
    assert.deepEqual(r.outcome, { kind: 'staleEpoch' });
    assert.deepEqual([src.commits, src.restarts, src.rollbacks], [0, 0, 1]);
  });

  it('should abandon an attempt that passes abandonBeforeCommitMs and start afresh without a restart', async () => {
    const clock = new ManualClock(0);
    const src = new ScriptedSource([() => { clock.set(2_001); }]);
    const r = await runProtocol(src, opts(clock));
    assert.deepEqual(r.outcome, { kind: 'committed' });
    assert.deepEqual([src.opened, src.restarts, src.rollbacks, src.commits], [2, 0, 1, 1]);
    assert.deepEqual([r.freshAttempts, r.abandons], [1, 1]);
    assert.deepEqual([r.beganMs, r.commitStartMs], [0, 2_001]);
  });

  it('should not abandon an attempt that takes exactly abandonBeforeCommitMs', async () => {
    const clock = new ManualClock(0);
    const src = new ScriptedSource([() => { clock.set(2_000); }]);
    const r = await runProtocol(src, opts(clock));
    assert.deepEqual([r.outcome, r.abandons, src.opened], [{ kind: 'committed' }, 0, 1]);
  });

  it('should answer failed for an error that is not retryable and roll back', async () => {
    const src = new ScriptedSource([fail('23505', 'duplicate key value')]);
    const r = await runProtocol(src, opts(new ManualClock()));
    assert.deepEqual(r.outcome, { kind: 'failed', code: '23505' });
    assert.deepEqual([src.restarts, src.rollbacks, src.commits], [0, 1, 0]);
    assert.deepEqual(src.closed, [true]);
  });

  it('should answer failed when BEGIN cannot open a transaction', async () => {
    const src: TxnSource = { open: async () => { throw dbError('08006', 'connection failure'); } };
    const r = await runProtocol(src, opts(new ManualClock()));
    assert.deepEqual(r.outcome, { kind: 'failed', code: '08006' });
  });

  it('should use a new transaction for each retry in fresh mode (YugabyteDB) with the same budget', async () => {
    const src = new ScriptedSource(Array.from({ length: 20 }, () => fail('40001', 'Restart read required')));
    const r = await runProtocol(src, opts(new ManualClock(), { flavour: 'yugabyte', restartMode: 'fresh' }));
    assert.deepEqual(r.outcome, { kind: 'retry' });
    assert.deepEqual([src.opened, src.restarts, src.attempts, src.rollbacks], [7, 0, 7, 7]);
    assert.equal(r.aborts.length, 7);
    assert.deepEqual(r.restarts, []);
  });
});
