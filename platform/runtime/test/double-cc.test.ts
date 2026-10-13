/**
 * Self-test of @share/owner-runtime/testing: each C01 consumer test CC-1 … CC-8 (§10.2) can be driven
 * by the double. A small sample owner (a counter with a deadline timer and a downstream command)
 * plays the consumer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AppendResult, CommandEnvelope, EntryInput, Epoch, FeedEvent, Generation, OwnerDeclaration, OwnerHooks, OwnerRuntime,
  PartitionKey, RoutingRefusal, SlotNo,
} from '../src/index.ts';
import { decodeJson, hex, hlcAddMs, slotOfPartition, utf8, validateDeclaration } from '../src/index.ts';
import {
  CommandPeerDouble, REFUSALS, RESULTS, RuntimeDouble, UNKNOWN_REFUSAL, UNKNOWN_RESULT, feedEvent,
} from '../testing/index.ts';

const AUDIT = { schema: 'audit.v1', principal: { principal_id: 'internal_service', kind: 'service', tenant: 'share' },
  decided_at: 'commit', policy_version: 1 } as const;

const DECL: OwnerDeclaration = {
  kind: 'sample', slotCount: 4,
  entryKinds: [
    { kind: 1, name: 'incremented', schemaVersions: [1], retention: '7y' },
    { kind: 2, name: 'takeover', schemaVersions: [1], retention: 'ops' },
    { kind: 3, name: 'applied', schemaVersions: [1], retention: '7y' },
  ],
  projections: [
    { name: 'decision', ddl: 'partition BYTES NOT NULL, request STRING NOT NULL, PRIMARY KEY (partition, request)', clearColumns: ['partition', 'request'] },
  ],
  streams: [{ name: 'counter', topic: 'sample.counter.v1', key: 'partition', emitFn: { version: 1 }, closure: 'none', consumers: ['probe_results'] }],
};

type Outcome = 'acked' | 'retryLater' | 'unavailable' | 'rerouted' | 'conditionFailed' | 'slotLost' | 'alerted';

/** The sample consumer owner. It follows C01 §3.2 for every result. */
class SampleOwner implements OwnerHooks {
  readonly acks: string[] = [];
  readonly alerts: string[] = [];
  readonly released: SlotNo[] = [];
  readonly rebuilt: string[] = [];
  readonly takeoverDue = new Set<string>();
  readonly applied = new Map<string, bigint>();       // CC-6: (partition, stream) → applied stream_seq
  readonly counterState = new Map<string, number>();
  readonly droppedCommands: string[] = [];
  readonly lostSlots: SlotNo[] = [];
  private readonly rt: OwnerRuntime;
  constructor(rt: OwnerRuntime) {
    this.rt = rt;
  }

  async onAcquire(slot: SlotNo, _epoch: Epoch): Promise<void> {
    for (const p of this.partitionsOf(slot)) this.rearm(p);
  }
  onRelease(slot: SlotNo): void { this.released.push(slot); }
  onReportable(): void {}
  onMovedOut(partition: PartitionKey): void { this.rt.cancelTimer(partition, 'deadline'); }
  async onAdopt(partition: PartitionKey, _g: Generation): Promise<void> {
    this.rearm(partition);
    this.takeoverDue.add(hex(partition));
  }
  async onNotification(): Promise<void> {}

  private readonly known = new Set<string>();
  private partitionsOf(slot: SlotNo): PartitionKey[] {
    return [...this.known].map((h) => new Uint8Array(Buffer.from(h, 'hex'))).filter((p) => slotOfPartition(p, DECL.slotCount) === slot);
  }
  rearm(p: PartitionKey): void {
    this.rt.timer(p, 'deadline', hlcAddMs(this.rt.now().ts, 1_000));
  }

  /** Increment once per request id; "confirm if undecided" by rowAbsent on the decision row. */
  async increment(p: PartitionKey, request: string): Promise<Outcome> {
    this.known.add(hex(p));
    const identity = utf8(`inc:${request}`);
    for (let attempt = 0; attempt < 5; attempt++) {
      const entries: EntryInput[] = [];
      if (this.takeoverDue.delete(hex(p))) entries.push({ kind: 2, schemaV: 1, identity: utf8(`takeover:${hex(p)}`), audit: AUDIT, payload: {} });
      const decisionRow = { table: 'sample_decision', key: { partition: p, request } };
      const r: AppendResult = await this.rt.append({
        partition: p,
        conditions: [{ kind: 'rowAbsent', row: decisionRow, label: 'undecided' }],
        decide: () => ({
          entries: [...entries, { kind: 1, schemaV: 1, identity, audit: AUDIT, payload: { request }, emits: [{ stream: 'counter', event: { request } }] }],
          projections: [{ table: 'sample_decision', op: 'upsert', key: { partition: p, request }, row: { partition: p, request } }],
        }),
      });
      switch (r.r) {
        case 'Committed':
          this.rearm(p);
          if (this.rt.leaseValid(slotOfPartition(p, DECL.slotCount)).valid) this.reply(`ack:${request}`);
          return 'acked';
        case 'ConditionFailed': return 'conditionFailed';
        case 'Stopped': return 'unavailable';
        case 'Moved': return 'rerouted';
        case 'StaleEpoch': this.lostSlots.push(slotOfPartition(p, DECL.slotCount)); return 'slotLost';
        case 'Moving': case 'Retry': case 'Ambiguous': case 'Overloaded':
          this.rebuilt.push(hex(p));          // not known to be committed ⇒ rebuild before the next decision
          continue;                           // retry with the same identity
        default:
          this.alerts.push(`unknown result ${(r as { r: string }).r}`);  // C01 §8: unknown ⇒ Retry + alert
          this.rebuilt.push(hex(p));
          continue;
      }
    }
    return 'retryLater';
  }

  reply(label: string): void {
    (this.rt as RuntimeDouble).recordReply?.(label);
    this.acks.push(label);
  }

  /** Send a command downstream from memory, handling every refusal per C01 §3.8 / D4. */
  async command(peer: CommandPeerDouble, from: PartitionKey, to: PartitionKey, identity: Uint8Array): Promise<string> {
    const slot = slotOfPartition(from, DECL.slotCount);
    for (let i = 0; i < 4; i++) {
      if (!this.rt.leaseValid(slot).valid) return 'noLease';
      const route = this.rt.route('downstream', to);
      const env: CommandEnvelope = {
        routedTo: { kind: 'downstream', slot: route.slot, generation: route.generation, epoch: route.epoch },
        sender: { kind: 'sample', partition: from, generation: this.rt.generation(from), epoch: this.rt.epoch(slot) },
        identity,
      };
      const a = await peer.send(env, {});
      if (a.ok) return 'ok';
      const out = this.onRefusal(a.refusal, slot, env, identity);
      if (out !== 'retry') return out;
    }
    return 'gaveUp';
  }

  private onRefusal(r: RoutingRefusal, slot: SlotNo, env: CommandEnvelope, identity: Uint8Array): string {
    switch (r.code) {
      case 'MOVING': case 'MOVED': case 'STALE_EPOCH': case 'NOT_OWNER': case 'STOPPED': case 'OVERLOADED':
        assert.equal(hex(identity), hex(env.identity));
        return 'retry';
      case 'STALE_SENDER':
        if (r.recorded.generation === env.sender.generation && r.recorded.epoch > env.sender.epoch) {
          this.lostSlots.push(slot); return 'slotLost';
        }
        if (r.recorded.generation > env.sender.generation) { this.droppedCommands.push(hex(identity)); return 'dropped'; }
        this.alerts.push('stale sender defect'); return 'dropped';
      case 'UNAVAILABLE': return 'unavailable';
      default: this.alerts.push('unknown refusal'); return 'unavailable';   // C01 §8: unknown ⇒ UNAVAILABLE
    }
  }

  /** CC-6: idempotent consumption by (partition, stream, stream_seq); checkpoint recorded in the applying append. */
  async consume(e: FeedEvent): Promise<void> {
    const k = `${hex(e.headers.partition)}|${e.headers.stream}`;
    const seq = BigInt(e.headers.stream_seq ?? '0');
    const last = this.applied.get(k) ?? 0n;
    if (seq !== last + 1n) return;                     // duplicate or out of order: the runtime buffers; dropped here
    const body = decodeJson(e.value) as { add: number };
    const r = await this.rt.append({ partition: e.headers.partition, entries: [{ kind: 3, schemaV: 1,
      identity: utf8(`applied:${k}:${seq}`), audit: AUDIT, payload: { checkpoint: { k, seq: seq.toString() } } }] });
    if (r.r !== 'Committed') return;
    this.applied.set(k, seq);
    this.counterState.set(k, (this.counterState.get(k) ?? 0) + body.add);
  }
}

const P = utf8('partition-x');
const SLOT = slotOfPartition(P, DECL.slotCount);

function setup(): { rt: RuntimeDouble; owner: SampleOwner } {
  const rt = new RuntimeDouble({ declaration: DECL });
  const owner = new SampleOwner(rt);
  rt.attach(owner);
  return { rt, owner };
}

test('CC-1: every AppendResult and an unknown one; retries keep identities; ack only after Committed', async () => {
  const cases: Array<[AppendResult, Outcome]> = [
    [RESULTS.ConditionFailed('undecided'), 'conditionFailed'],
    [RESULTS.Stopped(), 'unavailable'],
    [RESULTS.Moved(3, 1), 'rerouted'],
    [RESULTS.StaleEpoch(), 'slotLost'],
  ];
  for (const [res, expected] of cases) {
    const { rt, owner } = setup();
    rt.scriptAppend(res);
    assert.equal(await owner.increment(P, 'q1'), expected, res.r);
    assert.deepEqual(owner.acks, [], `no ack after ${res.r}`);
  }
  for (const res of [RESULTS.Retry(), RESULTS.Moving(), RESULTS.Ambiguous(), RESULTS.Overloaded(50), UNKNOWN_RESULT]) {
    const { rt, owner } = setup();
    rt.scriptAppend(res);                         // then the default path commits
    assert.equal(await owner.increment(P, 'q1'), 'acked');
    assert.equal(rt.appends.length, 2);
    const ids = rt.appends.map((a) => a.call.decide?.({} as never)?.entries.at(-1)?.identity).map((i) => i && hex(i));
    assert.equal(ids[0], ids[1], `same identity after ${res.r}`);
    assert.deepEqual(owner.acks, ['ack:q1']);
    assert.deepEqual(owner.rebuilt, [hex(P)]);
    if (res === UNKNOWN_RESULT) assert.equal(owner.alerts.length, 1);
  }
});

test('CC-2: onMovedOut cancels timers; appends for X answer Moving, then Moved once adopted', async () => {
  const { rt, owner } = setup();
  assert.equal(await owner.increment(P, 'q1'), 'acked');
  assert.equal(rt.timersOf(P).length, 1);
  rt.moveOut(P, 3);
  assert.equal(rt.timersOf(P).length, 0);
  rt.advance(5_000);
  assert.equal(rt.trace.filter((t) => t.t === 'timerFired').length, 0, 'no timer of X fires');
  assert.equal((await rt.append({ partition: P, entries: [] })).r, 'Moving');
  rt.markAdoptedElsewhere(P);
  assert.deepEqual(await rt.append({ partition: P, entries: [] }), { r: 'Moved', slot: 3, generation: 1 });
});

test('CC-3: onAdopt re-arms timers as onAcquire would, writes the takeover entry first; rowAbsent survives a takeover', async () => {
  const { rt, owner } = setup();
  assert.equal(await owner.increment(P, 'q1'), 'acked');
  const armedByCommit = rt.timersOf(P).map((t) => t.key);
  rt.moveOut(P, SLOT);
  await rt.adopt(P, 1);
  assert.deepEqual(rt.timersOf(P).map((t) => t.key), armedByCommit);
  assert.equal(await owner.increment(P, 'q2'), 'acked');
  const kinds = rt.log(P).map((e) => e.entry.kind);
  assert.deepEqual(kinds, [1, 2, 1], 'takeover entry is in X\'s first batch after adopt');
  await rt.takeover(SLOT);
  assert.equal(await owner.increment(P, 'q1'), 'conditionFailed', 'decision before the move still fails rowAbsent');
});

test('CC-4: Stopped ⇒ decide nothing, unavailable; resumes after the stop is lifted', async () => {
  const { rt, owner } = setup();
  rt.stop(P);
  assert.equal(await owner.increment(P, 'q1'), 'unavailable');
  assert.equal(rt.log(P).length, 0);
  rt.resume(P);
  assert.equal(await owner.increment(P, 'q1'), 'acked');
});

test('CC-5: sender handles every refusal (and an unknown one); receiver admitCommand refuses below the recorded fence', async () => {
  const { rt, owner } = setup();
  const peer = new CommandPeerDouble(rt);
  const id = utf8('cmd-1');
  peer.scriptRefusal(REFUSALS.MOVING(), REFUSALS.MOVED(), REFUSALS.STALE_EPOCH(), 'ok');
  assert.equal(await owner.command(peer, P, utf8('d'), id), 'ok');
  assert.ok(peer.sent.every((s) => hex(s.envelope.identity) === hex(id)));
  peer.scriptRefusal(REFUSALS.NOT_OWNER(), REFUSALS.STOPPED(), REFUSALS.OVERLOADED(), 'ok');
  assert.equal(await owner.command(peer, P, utf8('d'), id), 'ok');
  peer.scriptRefusal(REFUSALS.STALE_SENDER({ generation: 0, epoch: 5n }));
  assert.equal(await owner.command(peer, P, utf8('d'), id), 'slotLost');
  peer.scriptRefusal(REFUSALS.STALE_SENDER({ generation: 1, epoch: 1n }));
  assert.equal(await owner.command(peer, P, utf8('d'), id), 'dropped');
  assert.equal(owner.lostSlots.length, 1, 'higher generation keeps the slot');
  peer.scriptRefusal(REFUSALS.UNAVAILABLE());
  assert.equal(await owner.command(peer, P, utf8('d'), id), 'unavailable');
  peer.scriptRefusal(UNKNOWN_REFUSAL);
  assert.equal(await owner.command(peer, P, utf8('d'), id), 'unavailable');
  assert.deepEqual(owner.alerts, ['unknown refusal']);

  const sender = { kind: 'upstream', partition: utf8('u') };
  rt.recordFence(sender, { generation: 0, epoch: 3n });
  await rt.takeover(SLOT);
  assert.deepEqual(rt.admitCommand(sender, { generation: 0, epoch: 2n }), { admit: false, recorded: { generation: 0, epoch: 3n } });
  assert.deepEqual(rt.admitCommand(sender, { generation: 0, epoch: 3n }), { admit: true });
  assert.deepEqual(rt.admitCommand(sender, { generation: 1, epoch: 1n }), { admit: true });
});

test('CC-6: replaying a feed twice and out of order yields the same state; checkpoint in the applying append', async () => {
  const events = [1, 2, 3].map((n) => feedEvent({ partition: P, stream: 'counter', streamSeq: BigInt(n), event: { add: n } }));
  const run = async (order: FeedEvent[]): Promise<number | undefined> => {
    const { rt, owner } = setup();
    rt.subscribe('sample.counter.v1', { positions: [] }, 'committed', (e) => owner.consume(e));
    for (const e of order) await rt.deliver('sample.counter.v1', e);
    assert.ok(rt.log(P).every((l) => (l.entry.payload as { checkpoint?: unknown }).checkpoint !== undefined));
    return owner.counterState.get(`${hex(P)}|counter`);
  };
  const [e1, e2, e3] = events as [FeedEvent, FeedEvent, FeedEvent];
  assert.equal(await run([e1, e2, e3]), 6);
  assert.equal(await run([e1, e1, e2, e2, e3, e3, e1]), 6);
});

test('CC-7: every reply and command from memory is preceded by leaseValid (instrumented)', async () => {
  const { rt, owner } = setup();
  await owner.increment(P, 'q1');
  await owner.command(new CommandPeerDouble(rt), P, utf8('d'), utf8('c'));
  assert.deepEqual(rt.unleasedActions(), []);
  rt.setLease(SLOT, false);
  await owner.increment(P, 'q2');
  assert.equal(owner.acks.length, 1, 'no reply without a valid lease');
  assert.equal(await owner.command(new CommandPeerDouble(rt), P, utf8('d'), utf8('c')), 'noLease');
  // A deliberately broken owner is caught.
  rt.setLease(SLOT, true);
  rt.recordReply('unchecked');
  assert.equal(rt.unleasedActions().length, 1);
});

test('CC-8: the declaration validates (entry kinds, retention, keys led by partition, streams, consumers, closure)', () => {
  assert.deepEqual(validateDeclaration(DECL), []);
  const bad: OwnerDeclaration = { ...DECL, projections: [{ name: 'p', ddl: 'slot INT4, partition BYTES, PRIMARY KEY (slot, partition)', clearColumns: [] }] };
  assert.match(validateDeclaration(bad).join(), /begins with slot/);
  assert.equal(DECL.streams[0]?.closure, 'none');
  assert.deepEqual(DECL.streams[0]?.consumers, ['probe_results']);
});

test('double: decide re-runs on scripted restarts with a fresh ts; ctx.read refuses undeclared rows', async () => {
  const rt = new RuntimeDouble({ declaration: DECL });
  const seen: string[] = [];
  rt.scriptRestarts(3);
  const r = await rt.append({ partition: P, decide: (ctx) => { seen.push(ctx.ts); return { entries: [] }; } });
  assert.equal(r.r, 'Committed');
  assert.equal(rt.decideRuns[0], 4);
  assert.equal(new Set(seen).size, 4);
  await assert.rejects(rt.append({ partition: P, decide: (ctx) => { ctx.read({ table: 'sample_decision', key: {} }); return null; } }), /undeclared/);
});
