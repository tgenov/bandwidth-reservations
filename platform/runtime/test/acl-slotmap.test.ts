/** Kafka producer ACLs (C01 §2.5) and the placement slot-map feed with a fixed map (C01 §2.7, §3.8). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OwnerDeclaration, SlotMapVersion } from '../src/index.ts';
import {
  CockroachOwnerRuntime, ManualLoad, SlotMapCache, aclCommands, checkAcls, fixedSlotMap, hlc, home, kafkajsAcls, producerAcls,
  publishSlotMap, slotOfInMap, utf8,
} from '../src/index.ts';
import { MemoryBus, MemoryStore } from '../testing/index.ts';

const link: OwnerDeclaration = {
  kind: 'link', slotCount: 4, entryKinds: [], projections: [],
  streams: [{ name: 'schedule', topic: 'link.schedule.v1', key: 'partition', emitFn: { version: 1 }, closure: 'closedPerLink', consumers: ['account'] }],
};
const account: OwnerDeclaration = {
  kind: 'account', slotCount: 8, entryKinds: [], projections: [], statusReaders: true,
  streams: [{ name: 'outcome', topic: 'account.outcome.v1', key: 'slot', emitFn: { version: 1 }, closure: 'none', reportGated: true, consumers: ['notifier'] }],
};

test('should name exactly the producing principals of every topic (C01 §2.5) when building the ACL', () => {
  const acls = producerAcls([link, account], { extra: [{ topic: 'settlement.posting-acks.v1', producers: ['settlement-holder', 'settlement-relay'], contractRef: 'C06 v1 CI6-3' }] });
  const by = new Map(acls.map((a) => [a.topic, a.producers]));
  assert.deepEqual(by.get('link.schedule.v1'), ['link-holder', 'link-relay']);
  assert.deepEqual(by.get('link.schedule.v1.closure'), ['closure-emitter-link']);
  assert.equal(by.get('account.outcome.v1.closure'), undefined, 'no closure topic without closure');
  assert.deepEqual(by.get('account.outcome.v1'), ['account-holder', 'account-relay'], 'report markers ride the outcome topic');
  assert.deepEqual(by.get('cdc.link'), ['cockroach-cdc']);
  assert.deepEqual(by.get('cdc.audit.account'), ['cockroach-cdc']);
  assert.deepEqual(by.get('relay.progress.link'), ['link-relay']);
  assert.deepEqual(by.get('link.alert.v1'), ['link-holder', 'link-relay']);
  assert.deepEqual(by.get('link.notifications.v1'), ['link-holder', 'link-relay']);
  assert.deepEqual(by.get('placement.slot_map.v1'), ['placement-holder', 'placement-relay']);
  assert.deepEqual(by.get('settlement.posting-acks.v1'), ['settlement-holder', 'settlement-relay']);
  assert.ok(aclCommands(acls).every((c) => /--operation Write --resource-pattern-type literal --topic /.test(c)));
  assert.equal(kafkajsAcls(acls).length, acls.reduce((n, a) => n + a.producers.length, 0));
  // The check finds an extra writer and a missing one.
  const actual = new Map(acls.map((a) => [a.topic, [...a.producers]]));
  assert.deepEqual(checkAcls(acls, actual), []);
  actual.set('link.schedule.v1.closure', ['closure-emitter-link', 'link-holder']);
  actual.set('relay.progress.link', []);
  const findings = checkAcls(acls, actual);
  assert.equal(findings.length, 2);
  assert.throws(() => producerAcls([link], { extra: [{ topic: 'link.schedule.v1', producers: ['x'], contractRef: 'bad' }] }), /two producer lists/);
});

test('should keep a fixed slot map from the feed with versions in order and duplicates ignored, and stop routing when a conflicting copy arrives', async () => {
  const bus = new MemoryBus();
  const v1 = fixedSlotMap(8, hlc('1'));
  await publishSlotMap(bus, v1);
  const cache = new SlotMapCache({ bus });
  await cache.start();
  assert.ok(await cache.ready(1_000));
  const a = utf8('acct-77');
  assert.deepEqual(cache.slotOf(a), { slot: home(a) % 8, mapVersion: 1n, headDecides: false });
  // The runtime answers slotOf and route('account') from the feed.
  const store = new MemoryStore();
  store.seedSlots('account', 8);
  const rt = new CockroachOwnerRuntime({ declaration: account, store, slots: [], load: new ManualLoad(), slotMap: cache });
  assert.deepEqual(rt.slotOf(a), { slot: home(a) % 8, mapVersion: 1n, headDecides: false });
  assert.equal(rt.route('account', a).mapVersion, 1n);
  // An older or equal version is ignored; a newer one applies.
  const v2: SlotMapVersion = { ...v1, version: 2n, overrides: [{ account: a, slot: 5, reason: 'reslot' }] };
  await publishSlotMap(bus, v2);
  await publishSlotMap(bus, v1);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(cache.slotOf(a), { slot: 5, mapVersion: 2n, headDecides: false });
  // Splitting: the upper half answers s with headDecides.
  const split: SlotMapVersion = { ...v1, version: 3n, slotCount: 16, previousCount: 8, splitState: { [home(a) % 8]: 'splitting' } };
  const ans = slotOfInMap(split, a);
  assert.equal(ans.slot, home(a) % 8);
  assert.equal(ans.headDecides, home(a) % 16 === home(a) % 8 + 8);
  // Same version, other content: impossible (insert-only) ⇒ stop routing.
  await publishSlotMap(bus, { ...v2, slotCount: 4 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(cache.broken, true);
  assert.equal(cache.slotOf(a), undefined);
  await cache.stop();
});
