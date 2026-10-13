/**
 * C01 provider suite: the owner runtime behaviours that the real runtime core and the runtime double
 * (`@share/owner-runtime/testing`) both claim. Tests come from C01 §10.1 (CP-n) and §10.2 (CC-n).
 *
 * The subject is started and holds every slot of `C01_SUITE_DECLARATION`. The suite never looks inside it.
 */
import assert from 'node:assert/strict';
import type {
  AppendResult, AuditFields, EntryInput, Epoch, Generation, HlcTs, OwnerDeclaration, OwnerKind, OwnerRuntime, PartitionKey,
  RowRef, Seq, SlotNo, StreamSeq,
} from '@share/owner-runtime';
import { bytes, compareTs, subjectTest, type Closable, type SubjectFactory } from './support.ts';

/** The owner kind that every C01 subject must run. */
export const C01_SUITE_DECLARATION: OwnerDeclaration = {
  kind: 'csuite', slotCount: 4,
  entryKinds: [{ kind: 1, name: 'noted', schemaVersions: [1], retention: 'ops' }],
  projections: [
    { name: 'mark', ddl: 'partition BYTES NOT NULL, id STRING NOT NULL, PRIMARY KEY (partition, id)', clearColumns: ['partition', 'id'], deletable: true },
  ],
  streams: [{ name: 'counter', topic: 'csuite.counter.v1', key: 'partition', emitFn: { version: 1 }, closure: 'none', consumers: [] }],
};

/** A log row as the runtime gives it for a rebuild (C01 §3.1 "Rebuilding a partition"). */
export interface C01LogRow {
  seq: Seq; ts: HlcTs; epoch: Epoch; generation: Generation; kind: number; identity: Uint8Array;
  emits: Array<[string, StreamSeq]>;
  /** The payload as the owner gave it in `EntryInput.payload`, without a runtime envelope. */
  payload: unknown;
  senderFence?: { kind: OwnerKind; partition: PartitionKey; generation: Generation; epoch: Epoch };
}

export interface C01Subject extends Closable {
  /** The runtime, started with `C01_SUITE_DECLARATION`, that holds every slot. */
  runtime: OwnerRuntime;
  /** The slot of a partition in this runtime. */
  slotOf(partition: PartitionKey): SlotNo;
  /** Resolves when `onReportable(slot)` was called. */
  reportable(slot: SlotNo): Promise<void>;
  /** The opened log rows of a partition from `fromSeq`, in sequence order. */
  readLog(partition: PartitionKey, fromSeq?: Seq): Promise<C01LogRow[]>;
  /** A C02 `link_displacement` marker row for (link, request) with this attempt. */
  putDisplacementMarker(link: PartitionKey, request: Uint8Array, attempt: number): void;
  /** The next append restarts `n` times before its last attempt commits. */
  restartNext(n: number): void;
  /** The subject's hook calls, in order: `movedOut:<hex>`, `adopt:<hex>:<generation>` (S-PLAT-I3). */
  events: string[];
  /**
   * The move protocol (C01 §3.3), from the subject (slot A) to a target slot B of the same kind held by `target`.
   * `moveOut` runs steps 1 to 3 (B prepared, `moved` committed in A); `adopt` runs steps 4 and 5 in B.
   */
  moves: {
    target: { runtime: OwnerRuntime; slot: SlotNo; events: string[] };
    moveOut(partition: PartitionKey): Promise<void>;
    adopt(partition: PartitionKey): Promise<void>;
  };
  /** Placement's integrity stop and resume of a partition (C01 §2.6, §3.2), enforced at the subject's slot fence. */
  stops: {
    stop(partition: PartitionKey, detectionRef: Uint8Array): Promise<void>;
    resume(partition: PartitionKey): Promise<void>;
  };
}

/** Hooks that record the move hooks as `events` entries (subjects use it). */
export function c01MoveEvents(events: string[]): Pick<import('@share/owner-runtime').OwnerHooks, 'onMovedOut' | 'onAdopt'> {
  const h = (p: PartitionKey): string => Buffer.from(p).toString('hex');
  return {
    onMovedOut(p) { events.push(`movedOut:${h(p)}`); },
    async onAdopt(p, g) { events.push(`adopt:${h(p)}:${g}`); },
  };
}

const AUDIT: AuditFields = {
  schema: 'audit.v1', principal: { principal_id: 'internal_service', kind: 'service', tenant: 'share' },
  decided_at: 'commit', policy_version: 1,
};
const MARK = `${C01_SUITE_DECLARATION.kind}_mark`;

function entry(id: string, opts: { emit?: boolean; payload?: unknown; senderFence?: EntryInput['senderFence'] } = {}): EntryInput {
  return {
    kind: 1, schemaV: 1, identity: bytes(id), audit: AUDIT, payload: opts.payload ?? { id },
    ...(opts.emit ? { emits: [{ stream: 'counter', event: { id } }] } : {}),
    ...(opts.senderFence ? { senderFence: opts.senderFence } : {}),
  };
}

function mark(partition: PartitionKey, id: string): RowRef {
  return { table: MARK, key: { partition, id } };
}

function committed(r: AppendResult): Extract<AppendResult, { r: 'Committed' }> {
  assert.equal(r.r, 'Committed', `expected Committed, got ${JSON.stringify(r, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}`);
  return r as Extract<AppendResult, { r: 'Committed' }>;
}

function asTs(s: string): HlcTs {
  return s as HlcTs;
}

function identities(rows: C01LogRow[]): string[] {
  return rows.map((r) => Buffer.from(r.identity).toString('utf8'));
}

/** Wait until the report position of `slot` is at or above `ts`, by the onReport events, with a timeout. */
async function reportReaches(rt: OwnerRuntime, slot: SlotNo, ts: HlcTs, timeoutMs: number): Promise<HlcTs> {
  const reached = (): HlcTs | undefined => {
    const p = rt.reportPosition(slot);
    return p !== undefined && compareTs(p, ts) >= 0 ? p : undefined;
  };
  const now = reached();
  if (now) return now;
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { done = true; reject(new Error(`report position of slot ${slot} did not reach ${ts} in ${timeoutMs} ms`)); }, timeoutMs);
    rt.onReport((s) => {
      if (done || s !== slot) return;
      const p = reached();
      if (p) { done = true; clearTimeout(timer); resolve(p); }
    });
  });
}

/** Register the C01 provider suite against the subjects that `make` creates. */
export function runC01ProviderSuite(name: string, make: SubjectFactory<C01Subject>): void {
  const t = (id: string, behaviour: string, body: (s: C01Subject) => Promise<void>): void =>
    subjectTest('C01', id, name, behaviour, make, body);
  const P = bytes('c01-p1');

  t('CP-2', 'Committed: seq is contiguous, ts strictly increases, streamSeqs count each stream per partition', async (s) => {
    const r1 = committed(await s.runtime.append({ partition: P, entries: [entry('a', { emit: true }), entry('b', { emit: true })] }));
    const r2 = committed(await s.runtime.append({ partition: P, entries: [entry('c', { emit: true })] }));
    assert.deepEqual([r1.seqFrom, r1.seqTo, r2.seqFrom, r2.seqTo], [1n, 2n, 3n, 3n]);
    assert.deepEqual(r1.streamSeqs['counter'], [1n, 2n]);
    assert.deepEqual(r2.streamSeqs['counter'], [3n, 3n]);
    assert.equal(compareTs(r1.ts, r2.ts), -1);
    const log = await s.readLog(P);
    assert.deepEqual(log.map((l) => l.seq), [1n, 2n, 3n]);
    assert.deepEqual(identities(log), ['a', 'b', 'c']);
    assert.deepEqual(log.map((l) => l.ts), [r1.ts, r1.ts, r2.ts]);
    assert.deepEqual(log.map((l) => l.emits), [[['counter', 1n]], [['counter', 2n]], [['counter', 3n]]]);
  });

  t('CP-2', 'ConditionFailed(label): rowAbsent and rowPresent fail by their label, and the failed call writes nothing', async (s) => {
    const m = mark(P, 'm1');
    committed(await s.runtime.append({ partition: P, entries: [entry('w')], projections: [{ table: MARK, op: 'upsert', key: m.key, row: { v: 1 } }] }));
    assert.deepEqual(await s.runtime.append({ partition: P, conditions: [{ kind: 'rowAbsent', row: m, label: 'unmarked' }], entries: [entry('x')] }),
      { r: 'ConditionFailed', which: 'unmarked' });
    assert.deepEqual(await s.runtime.append({ partition: P, conditions: [{ kind: 'rowPresent', row: mark(P, 'none'), label: 'present' }], entries: [entry('y')] }),
      { r: 'ConditionFailed', which: 'present' });
    committed(await s.runtime.append({ partition: P, conditions: [{ kind: 'rowPresent', row: m, label: 'marked' }], entries: [entry('z')] }));
    assert.deepEqual(identities(await s.readLog(P)), ['w', 'z']);
  });

  t('CP-2', 'ConditionFailed(label): tsBefore fails when the commit ts is not below the bound', async (s) => {
    const past = asTs('1.0000000000');
    const future = asTs(`${BigInt(Date.UTC(2200, 0, 1)) * 1_000_000n}.0000000000`);
    assert.deepEqual(await s.runtime.append({ partition: P, conditions: [{ kind: 'tsBefore', bound: () => past, label: 'before-D' }], entries: [entry('late')] }),
      { r: 'ConditionFailed', which: 'before-D' });
    const r = committed(await s.runtime.append({ partition: P, conditions: [{ kind: 'tsBefore', bound: () => future, label: 'before-D' }], entries: [entry('early')] }));
    assert.equal(compareTs(r.ts, future), -1);
    assert.deepEqual(identities(await s.readLog(P)), ['early']);
  });

  for (const [marker, call] of [[1, 1], [2, 1], [1, 2]] as const) {
    t('CP-2', `displacementRead: a marker with attempt ${marker} fails a read with attempt ${call} (any attempt), and nothing commits`, async (s) => {
      const link = bytes('L1');
      const request = new Uint8Array([...bytes('acct'), 0, 0, 0, 0, 0, 0, 0, 7]);
      s.putDisplacementMarker(link, request, marker);
      const r = await s.runtime.append({ partition: P, entries: [entry('e5')],
        conditions: [{ kind: 'displacementRead', link, request, attempt: call, lockTimeoutMs: 10, label: 'displacement:0' }] });
      assert.equal(r.r, 'ConditionFailed');
      assert.equal(r.r === 'ConditionFailed' ? r.which : undefined, 'displacement:0');
      assert.equal(r.r === 'ConditionFailed' ? r.displacement?.attempt : undefined, marker);
      assert.deepEqual(await s.readLog(P), []);
    });
  }

  t('CP-2', 'displacementRead: no marker for (link, request) passes, also when another request of the link has a marker', async (s) => {
    const link = bytes('L1');
    s.putDisplacementMarker(link, new Uint8Array([...bytes('acct'), 0, 0, 0, 0, 0, 0, 0, 8]), 1);
    const request = new Uint8Array([...bytes('acct'), 0, 0, 0, 0, 0, 0, 0, 9]);
    committed(await s.runtime.append({ partition: P, entries: [entry('e5')],
      conditions: [{ kind: 'displacementRead', link, request, attempt: 1, lockTimeoutMs: 10, label: 'displacement:0' }] }));
    assert.deepEqual(identities(await s.readLog(P)), ['e5']);
  });

  t('CP-3', 'decide is re-run on every restart with a new, increasing ts; only the last attempt commits, at its ts', async (s) => {
    s.restartNext(2);
    const seen: HlcTs[] = [];
    const r = committed(await s.runtime.append({ partition: P,
      decide: (ctx) => { seen.push(ctx.ts); return { entries: [entry(`attempt-${seen.length}`)] }; } }));
    assert.equal(seen.length, 3);
    for (let i = 1; i < seen.length; i++) assert.equal(compareTs(seen[i - 1] as HlcTs, seen[i] as HlcTs), -1);
    assert.equal(r.ts, seen[2]);
    assert.deepEqual(identities(await s.readLog(P)), ['attempt-3']);
  });

  t('CP-3', 'decide: ctx.read serves declared reads and condition rows; an undeclared row throws; null withdraws the call', async (s) => {
    const declared = mark(P, 'd');
    const cond = mark(P, 'c');
    committed(await s.runtime.append({ partition: P, entries: [entry('setup')],
      projections: [{ table: MARK, op: 'upsert', key: declared.key, row: { v: 7 } }] }));
    const got: unknown[] = [];
    committed(await s.runtime.append({ partition: P, reads: [declared], conditions: [{ kind: 'rowAbsent', row: cond, label: 'free' }],
      decide: (ctx) => { got.push(ctx.read(declared), ctx.read(cond), ctx.conditionResults['free']); return { entries: [entry('read')] }; } }));
    assert.deepEqual(got, [{ v: 7 }, undefined, true]);
    await assert.rejects(s.runtime.append({ partition: P, decide: (ctx) => { ctx.read(mark(P, 'undeclared')); return { entries: [entry('never')] }; } }),
      /undeclared/);
    assert.deepEqual(await s.runtime.append({ partition: P, decide: () => null }), { r: 'ConditionFailed', which: 'decide' });
    assert.deepEqual(identities(await s.readLog(P)), ['setup', 'read']);
  });

  t('CP-7', 'report position: defined once onReportable is called, it reaches the ts of each commit and never goes back', async (s) => {
    const slot = s.slotOf(P);
    await s.reportable(slot);
    const p0 = s.runtime.reportPosition(slot);
    assert.notEqual(p0, undefined);
    const seen: HlcTs[] = [];
    s.runtime.onReport((sl, p) => { if (sl === slot) seen.push(p); });
    const r1 = committed(await s.runtime.append({ partition: P, entries: [entry('r1')] }));
    const p1 = await reportReaches(s.runtime, slot, r1.ts, 5_000);
    const r2 = committed(await s.runtime.append({ partition: P, entries: [entry('r2')] }));
    const p2 = await reportReaches(s.runtime, slot, r2.ts, 5_000);
    assert.ok(compareTs(p1, p2) <= 0);
    for (let i = 1; i < seen.length; i++) assert.ok(compareTs(seen[i - 1] as HlcTs, seen[i] as HlcTs) <= 0, `report position went back at ${i}`);
  });

  t('§3.1', 'readLog gives the payload as committed, without a runtime envelope, also with a sender fence', async (s) => {
    const sender = bytes('acct-1');
    const payload = { op: 'hold', n: 1n, raw: new Uint8Array([1, 2, 3]), nested: { list: ['a', 'b'] } };
    committed(await s.runtime.append({ partition: P, entries: [
      entry('plain', { payload: { op: 'plain' } }),
      entry('fenced', { payload, senderFence: { kind: 'account', partition: sender, generation: 0, epoch: 3n } }),
    ] }));
    payload.nested.list.push('changed after the append');
    const log = await s.readLog(P);
    assert.deepEqual(log.map((l) => l.payload), [{ op: 'plain' }, { op: 'hold', n: 1n, raw: new Uint8Array([1, 2, 3]), nested: { list: ['a', 'b'] } }]);
    assert.deepEqual(log.map((l) => l.kind), [1, 1]);
    assert.equal(log[0]?.senderFence, undefined);
    assert.deepEqual([log[1]?.senderFence?.generation, log[1]?.senderFence?.epoch], [0, 3n]);
    assert.deepEqual(identities(await s.readLog(P, 2n)), ['fenced']);
  });

  t('CP-5', 'MOVING in A between moved and adopt, MOVED(B, g+1) once adopted; no entry commits in B before adopt; onMovedOut after moved, onAdopt after adopt; seq continues in B', async (s) => {
    const hx = Buffer.from(P).toString('hex');
    committed(await s.runtime.append({ partition: P, entries: [entry('a1'), entry('a2')] }));
    const B = s.moves.target;
    await s.moves.moveOut(P);
    assert.deepEqual(s.events.filter((e) => e.startsWith('movedOut:')), [`movedOut:${hx}`]);
    assert.deepEqual(await s.runtime.append({ partition: P, entries: [entry('a3')] }), { r: 'Moving' });
    assert.deepEqual(await B.runtime.append({ partition: P, entries: [entry('b0')] }, { slot: B.slot }), { r: 'Moving' });
    assert.deepEqual(B.events.filter((e) => e.startsWith('adopt:')), []);
    await s.moves.adopt(P);
    assert.deepEqual(B.events.filter((e) => e.startsWith('adopt:')), [`adopt:${hx}:1`]);
    assert.deepEqual(await s.runtime.append({ partition: P, entries: [entry('a4')] }), { r: 'Moved', slot: B.slot, generation: 1 });
    const r = committed(await B.runtime.append({ partition: P, entries: [entry('b1', { emit: true })] }, { slot: B.slot }));
    assert.ok(r.seqFrom > 2n, `seq continues in B: ${r.seqFrom}`);
    assert.deepEqual(r.streamSeqs['counter'], [1n, 1n]);
    assert.equal(B.runtime.generation(P), 1);
  });

  t('CP-6', 'Stopped(detectionRef) while an integrity stop is open: nothing of the partition commits, another partition commits, resume lifts it', async (s) => {
    const ref = bytes('detection-1');
    const other = bytes('c01-other');
    committed(await s.runtime.append({ partition: P, entries: [entry('before')] }));
    await s.stops.stop(P, ref);
    assert.deepEqual(await s.runtime.append({ partition: P, entries: [entry('stopped')] }), { r: 'Stopped', detectionRef: ref });
    committed(await s.runtime.append({ partition: other, entries: [entry('free')] }));
    await s.stops.resume(P);
    committed(await s.runtime.append({ partition: P, entries: [entry('after')] }));
    assert.deepEqual(identities(await s.readLog(P)), ['before', 'after']);
  });

  t('CC-5', 'admitCommand: a committed sender fence is the high-water; a lower fence is refused with the recorded fence', async (s) => {
    const sender = { kind: 'account', partition: bytes('acct-2') };
    assert.deepEqual(s.runtime.admitCommand(sender, { generation: 0, epoch: 1n }), { admit: true });
    committed(await s.runtime.append({ partition: P, entries: [entry('cmd', { senderFence: { ...sender, generation: 1, epoch: 3n } })] }));
    assert.deepEqual(s.runtime.admitCommand(sender, { generation: 1, epoch: 2n }), { admit: false, recorded: { generation: 1, epoch: 3n } });
    assert.deepEqual(s.runtime.admitCommand(sender, { generation: 0, epoch: 9n }), { admit: false, recorded: { generation: 1, epoch: 3n } });
    assert.deepEqual(s.runtime.admitCommand(sender, { generation: 1, epoch: 3n }), { admit: true });
    assert.deepEqual(s.runtime.admitCommand(sender, { generation: 2, epoch: 1n }), { admit: true });
    assert.deepEqual(s.runtime.admitCommand({ kind: 'account', partition: bytes('acct-3') }, { generation: 0, epoch: 1n }), { admit: true });
  });
}
