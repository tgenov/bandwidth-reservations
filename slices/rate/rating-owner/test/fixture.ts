/** The P3-S25 fixture: account a1, product p1 (guaranteed) on route r1, usage_price 10,000 micro-USD per GB. */
import type { ChargeLineBatch, ObservationPoint } from '@share/rate-common';
import type { FixtureEntity } from '../src/index.ts';
import { buildWorld, type World } from '../testing/index.ts';
import { TOPIC_CHARGES } from '../src/index.ts';

export const DEPLOY_AT = Date.parse('2026-09-01T00:00:00Z');
export const MINUTE_1230 = Date.parse('2026-10-12T12:30:00Z');

export const CATALOGUE: FixtureEntity[] = [
  { entityType: 'product', productId: 'p1', kind: 'guaranteed', permitsBurst: true },
  { entityType: 'route', routeId: 'r1', legs: ['L1'] },
  // 10,000 micro-USD per GB = 10^10 pico-USD per GB (C06 Conventions).
  { entityType: 'price_version', product: 'p1', route: 'r1', priceKind: 'usage_price', priceVersion: 'pv1',
    price: '10000000000', effectiveFrom: '2026-10-02T00:00:00Z' },
  { entityType: 'split_weights', route: 'r1', weightsVersion: 'w1', effectiveFrom: '2026-09-01T00:02:00Z',
    legs: [{ link: 'L1', supplier: 's1', weight: 7 }], commissionWeight: 3 },
];

export const OP: ObservationPoint = { exporterId: 'e1', observationDomain: 7, ifIndex: 3, direction: 'egress' };

/** A world with the catalogue deployed, provisioning in place, and the clock at 12:31:00 on 2026-10-12. */
export async function readyWorld(relay: 'off' | 'both' | 'only' = 'off', handoffPartitions = 1): Promise<World> {
  const w = buildWorld({ startMs: DEPLOY_AT, relay, handoffPartitions });
  await w.deploy(CATALOGUE);
  await w.bus.jump(MINUTE_1230 - 30 * 60_000 - DEPLOY_AT);
  await w.provisioning.observationPoint(OP, 'L1', MINUTE_1230 - 30 * 60_000);
  await w.provisioning.binding({ op: OP, serviceTag: { vlan: { outer: 100 } }, accountId: 'a1', productId: 'p1', routeId: 'r1',
    validFromMs: MINUTE_1230 - 30 * 60_000 });
  await w.bus.jump(MINUTE_1230 + 60_000 - w.bus.nowMs);
  await w.provisioning.heartbeat('e1');
  await w.bus.settle();
  return w;
}

/** 1 GB of attachment-class traffic for a1 in the minute starting 12:30 (P3-S25). */
export const FLOW_1GB = {
  startMs: MINUTE_1230 + 10_000, endMs: MINUTE_1230 + 50_000, bytes: 1_000_000_000n, ifIndex: 3, vlan: 100,
};

/** Move to the usage closure of 12:30 and on until the batch is posted, with provisioning heartbeats. */
export async function runPastClosure(w: World, untilMs = MINUTE_1230 + 6 * 60_000): Promise<void> {
  await w.bus.advance(untilMs - w.bus.nowMs, 1_000, async () => {
    if (w.bus.nowMs % 5_000 === 0) await w.provisioning.heartbeat('e1');
  });
}

export function chargeBatches(w: World): ChargeLineBatch[] {
  return w.bus.eventsOn<ChargeLineBatch>(TOPIC_CHARGES);
}
