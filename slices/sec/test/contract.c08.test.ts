/**
 * C08 provider suite against the real identity owner and edge gateway (the S-SEC I1 skeleton on the runtime
 * double): §A principal context and §B status push. `catch_up` comes in S-SEC-I2.
 */
import { runC08ProviderSuite, type C08PrincipalContext, type C08StatusEvent, type C08Subject } from '@share/contract-suites';
import { CONTEXT_METADATA_KEY, decodeContext } from '@share/iam-lib';
import { STATUS_TOPIC } from '@share/identity-owner';
import { bearer, skeleton } from './harness.ts';

function isStatusEvent(e: unknown): e is C08StatusEvent {
  return typeof e === 'object' && e !== null && 'schema' in e && e.schema === 'iam.status.v1';
}

runC08ProviderSuite('real identity and edge', { context: true, pushed: true, catchUp: { pending: 'S-SEC-I2' } },
  async (): Promise<C08Subject> => {
    const s = await skeleton();
    const tokens = new Map<string, string>();
    const forwarded: Uint8Array[] = [];
    const inner = s.owner.command.bind(s.owner);
    s.owner.command = async (peer, md, cmd) => { forwarded.push(md[CONTEXT_METADATA_KEY]); return inner(peer, md, cmd); };
    return {
      issueKey: async (account) => {
        s.watch(account);
        const k = await s.issue(account);
        tokens.set(k.key_id, k.token);
        await s.tick();
        return k.key_id;
      },
      revokeKey: async (account, keyId) => { await s.revoke(account, keyId); await s.tick(); },
      advance: async (ms) => { s.advance(ms); },
      nowMicros: () => BigInt(s.nowMs()) * 1000n,
      context: async (account, keyId): Promise<C08PrincipalContext> => {
        const token = tokens.get(keyId);
        if (token === undefined) throw new Error(`no token for ${keyId}`);
        const r = await s.gateway.handle({ authorization: bearer(token), operation: 'status', account });
        const md = forwarded.at(-1);
        if (r.status !== 200 || md === undefined) throw new Error(`the edge did not forward: ${r.status} ${r.body}`);
        return decodeContext(md);
      },
      pushed: () => s.iamRt.published.filter((p) => p.topic === STATUS_TOPIC).map((p) => p.event).filter(isStatusEvent),
      close: async () => {},
    };
  });
