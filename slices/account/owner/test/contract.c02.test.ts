/** C02 provider suite (provider tests 1 to 4, the AM-I1 subset) against the account slice's link double. */
import { C02_SUITE_CAPACITY, runC02ProviderSuite, type C02Subject } from '@share/contract-suites';
import { hlcToWallMs, utf8 } from '@share/owner-runtime';
import { AccountTestRuntime, LinkDouble } from '../testing/index.ts';

runC02ProviderSuite('account link double', async (): Promise<C02Subject> => {
  const rt = new AccountTestRuntime({ startMs: Date.UTC(2026, 9, 12, 9, 0, 0) });
  const links = new LinkDouble(rt).addLink('L1', C02_SUITE_CAPACITY);
  return {
    port: links,
    link: 'L1',
    envelope: (account, sender = { generation: 0, epoch: 1n }) => ({
      routedTo: { kind: 'link', slot: 0, generation: 0, epoch: 1n },
      sender: { kind: 'account', partition: account, generation: sender.generation, epoch: sender.epoch },
      identity: utf8('c02-suite'),
    }),
    nowMs: () => hlcToWallMs(rt.now().ts),
    close: async () => {},
  };
});
