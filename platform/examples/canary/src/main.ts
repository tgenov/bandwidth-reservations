/**
 * Run the canary on the dev cell:  npm run dev:up && npm start -w @share/canary
 * Env: DATABASE_URL (default the dev cell), KAFKA_BROKERS (comma list; unset ⇒ no direct publish), SLOTS (e.g. "0-15").
 */
import { CockroachOwnerRuntime, KafkaPublisher, MemoryPublisher, PgStore, utf8 } from '@share/owner-runtime';
import { migrateKinds } from '@share/owner-migrate';
import { CanaryOwner } from './canary-owner.ts';
import { declaration } from './declaration.ts';

const url = process.env['DATABASE_URL'] ?? 'postgresql://root@localhost:26257/defaultdb?sslmode=disable';
const brokers = process.env['KAFKA_BROKERS']?.split(',').filter(Boolean) ?? [];
const [lo, hi] = (process.env['SLOTS'] ?? `0-${declaration.slotCount - 1}`).split('-').map(Number);
const slots = Array.from({ length: (hi ?? 0) - (lo ?? 0) + 1 }, (_, i) => (lo ?? 0) + i);

await migrateKinds(url, [declaration], { presplit: false });
const store = new PgStore({ connectionString: url });
const publisher = brokers.length > 0 ? new KafkaPublisher({ brokers, clientId: 'canary-holder' }) : new MemoryPublisher();
const runtime = new CockroachOwnerRuntime({
  declaration, store, slots, publisher,
  log: (msg, f) => console.log(JSON.stringify({ msg, ...f }, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))),
});
const owner = new CanaryOwner(runtime);
await runtime.start(owner);
console.log(`canary holds slots ${runtime.heldSlots().join(',')}`);

let n = 0;
const timer = setInterval(() => {
  const p = utf8(`canary-${n % 8}`);
  if (!owner.held.has(owner.slotOf(p))) { n++; return; }
  void owner.increment(p, `tick-${process.pid}-${n++}`).then((a) => console.log(JSON.stringify(a, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))));
}, 1_000);

const shutdown = async (): Promise<void> => {
  clearInterval(timer);
  await runtime.stop();
  await store.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
