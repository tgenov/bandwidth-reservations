/**
 * C08 provider suite against the identity doubles of the account slice: the principal-context fixture
 * (`agentContext`, as the edge builds it) and `IdentityDouble` (§B catch_up). The account slice has no
 * push double in AM-I1.
 */
import { runC08ProviderSuite, type C08Subject } from '@share/contract-suites';
import { hlcToWallMs, utf8 } from '@share/owner-runtime';
import { AccountTestRuntime, IdentityDouble, NINE_AM_MS, agentContext } from '../testing/index.ts';

runC08ProviderSuite('account identity doubles', { context: true, catchUp: true }, async (): Promise<C08Subject> => {
  const rt = new AccountTestRuntime({ startMs: NINE_AM_MS });
  const identity = new IdentityDouble(rt);
  const versions = new Map<string, number>();
  let n = 0;
  return {
    issueKey: async (account) => {
      n += 1;
      const keyId = `${account}-k${n}`;
      versions.set(keyId, 1);
      identity.addKey(account, keyId, 1, 'active');
      return keyId;
    },
    revokeKey: async (account, keyId) => {
      const v = (versions.get(keyId) ?? 0) + 1;
      versions.set(keyId, v);
      identity.addKey(account, keyId, v, 'revoked');
    },
    advance: async (ms) => { rt.advance(ms); },
    nowMicros: () => BigInt(hlcToWallMs(rt.now().ts)) * 1000n,
    context: async (account, keyId) => agentContext(account, keyId, hlcToWallMs(rt.now().ts)),
    catchUp: { call: (req) => identity.catchUp(req), accountSlot: (account) => rt.slotOf(utf8(account)).slot },
    close: async () => {},
  };
});
