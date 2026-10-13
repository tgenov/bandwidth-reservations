/** Audit append log, I1: C08 P-17, and the chain of audit's own log checked against C08 §J. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CockroachOwnerRuntime, ManualLoad, MemoryPublisher } from '@share/owner-runtime';
import { MemoryStore, RuntimeDouble } from '@share/owner-runtime/testing';
import { internalAudit, type AuditAppend } from '@share/iam-lib';
import { AUDIT_KIND, AuditService, declaration, sourcePartition, verifyAuditChain } from '../src/index.ts';

const EDGE = 'spiffe://share/edge/node-1';
const IAM = 'spiffe://share/iam/holder';

function rec(event: string, extra: Record<string, unknown> = {}): AuditAppend['record'] {
  return { ...internalAudit(EDGE), event, ...extra };
}

function onDouble() {
  const rt = new RuntimeDouble({ declaration });
  const pages: string[] = [];
  const audit = new AuditService({ runtime: rt, allowlist: new Set([EDGE, IAM]), page: (m) => pages.push(m), sleep: async () => {} });
  rt.attach(audit);
  return { rt, audit, pages };
}

test('C08 P-17: the source is the caller\'s mTLS identity, never a payload field', async () => {
  const { rt, audit } = onDouble();
  const a = await audit.append(EDGE, { source_ref: 'r1', record: rec('x', { new: { source: IAM } }) });
  assert.equal(a.kind, 'appended');
  assert.ok(a.kind === 'appended' && a.source === EDGE);
  assert.equal(rt.log(sourcePartition(EDGE)).length, 1);
  assert.equal(rt.log(sourcePartition(IAM)).length, 0);
});

test('C08 P-17: a source_ref pre-claimed by another source does not block the caller', async () => {
  const { audit } = onDouble();
  assert.equal((await audit.append(IAM, { source_ref: 'shared', record: rec('a') })).kind, 'appended');
  assert.equal((await audit.append(EDGE, { source_ref: 'shared', record: rec('b') })).kind, 'appended');
});

test('C08 P-17: same source, same source_ref, different record → source_ref_conflict, paged to security; same record → first position', async () => {
  const { rt, audit, pages } = onDouble();
  const first = await audit.append(EDGE, { source_ref: 'r', record: rec('a') });
  assert.deepEqual(await audit.append(EDGE, { source_ref: 'r', record: rec('a') }), first, 'idempotent');
  assert.deepEqual(await audit.append(EDGE, { source_ref: 'r', record: rec('b') }), { kind: 'refused', reason: 'source_ref_conflict' });
  assert.equal(pages.length, 1);
  assert.equal(rt.log(sourcePartition(EDGE)).length, 1, 'records are never altered');
});

test('C08 §J: a caller not on the allowlist is refused caller_not_allowed', async () => {
  const { rt, audit } = onDouble();
  assert.deepEqual(await audit.append('spiffe://share/unknown', { source_ref: 'r', record: rec('a') }), { kind: 'refused', reason: 'caller_not_allowed' });
  assert.equal(rt.appends.length, 0);
});

test('audit_append on the runtime core writes a record; its chain re-computes from C08 §J; a changed row is detected', async () => {
  const store = new MemoryStore();
  store.seedSlots(AUDIT_KIND, declaration.slotCount);
  const rt = new CockroachOwnerRuntime({ declaration, store, publisher: new MemoryPublisher(), load: new ManualLoad(),
    slots: Array.from({ length: declaration.slotCount }, (_, i) => i) });
  const audit = new AuditService({ runtime: rt, allowlist: new Set([EDGE, IAM]), page: () => {}, sleep: async () => {} });
  await rt.start(audit);
  try {
    for (let i = 0; i < 3; i++) assert.equal((await audit.append(EDGE, { source_ref: `e${i}`, record: rec(`e${i}`) })).kind, 'appended');
    assert.equal((await audit.append(IAM, { source_ref: 'i0', record: rec('i0') })).kind, 'appended');
    const rows = store.log.filter(() => true);
    assert.equal(rows.length, 4, 'one row per append');
    const ok = verifyAuditChain(AUDIT_KIND, rows);
    assert.deepEqual(ok, { ok: true, checked: 4, breaks: [] });
    // A changed sealed audit column breaks the chain at that row.
    const changed = rows.map((r) => (r.seq === 2n && Buffer.from(r.partition).toString() === `source/${EDGE}`
      ? { ...r, audit: new Uint8Array([...r.audit].map((b, j) => (j === 0 ? b ^ 1 : b))) } : r));
    const bad = verifyAuditChain(AUDIT_KIND, changed);
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.breaks.map((b) => [b.seq, b.reason]), [[2n, 'mismatch']]);
    // A missing row is a gap.
    const gap = verifyAuditChain(AUDIT_KIND, rows.filter((r) => !(r.seq === 1n && Buffer.from(r.partition).toString() === `source/${EDGE}`)));
    assert.deepEqual(gap.breaks.map((b) => b.reason), ['gap']);
  } finally {
    await rt.stop();
  }
});
