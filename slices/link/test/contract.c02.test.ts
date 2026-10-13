/** C02 provider suite (provider tests 1 to 8 and 13: the I1 subset and the I2, I3, I4, I5 and I6 parts) against the real link owner on the runtime double. */
import { C02_SUITE_CAPACITY, runC02ProviderSuite, type C02NotificationCopy, type C02Subject } from '@share/contract-suites';
import { hlcToWallMs, utf8 } from '@share/owner-runtime';
import { LINK_KIND } from '../src/index.ts';
import { harness } from './support.ts';

runC02ProviderSuite('real link owner', async (): Promise<C02Subject> => {
  const h = await harness({ link: 'L1', capacity: C02_SUITE_CAPACITY });
  return {
    port: h.owner,
    link: h.link,
    envelope: (account, sender = { generation: 0, epoch: 1n }) => {
      const route = h.rt.route(LINK_KIND, utf8(h.link));
      return {
        routedTo: { kind: LINK_KIND, slot: route.slot, generation: route.generation, epoch: route.epoch },
        sender: { kind: 'account', partition: account, generation: sender.generation, epoch: sender.epoch },
        identity: utf8('c02-suite'),
      };
    },
    nowMs: () => hlcToWallMs(h.rt.now().ts),
    notifications: () => ({ pushed: h.pushed as C02NotificationCopy[], relayed: h.rt.notificationsSent as C02NotificationCopy[] }),
    close: async () => { await h.owner.idle(); },
  };
}, { i2: true, i3: true, i4: true, i5: true, i6: true });
