/**
 * TEST-ONLY fixture commands (plan S-SEC §1 rule 5): create and revoke agent keys before the administrator
 * commands exist (I7). Accepted only from the test workload identity. This module is exported only from
 * `@share/identity-owner/testing`; the production entry must not import it (test "fixture lint").
 */
import { mintKey, type KeyLimits, type StatusActor, type Tenant } from '@share/iam-lib';
import type { IdentityOwner, KeyCommandAnswer } from './owner.ts';

export const FIXTURE_WORKLOAD = 'spiffe://share/test/sec-fixture';

/** The fixture stands in for an account administrator of I7; this pseudonymous identifier names it. */
const FIXTURE_ADMIN: StatusActor = { kind: 'administrator', principal_id: 'f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1' };

export type FixtureAnswer<T> = T | { ok: false; reason: 'caller_not_allowed' };

export class KeyFixture {
  private readonly owner: IdentityOwner;
  constructor(owner: IdentityOwner) {
    this.owner = owner;
  }

  /** Issue an agent key for `account`. Answers the bearer token once; identity keeps only its verifier. */
  async issueAgentKey(caller: string, account: string, opts: { limits?: KeyLimits; probe?: boolean } = {}):
    Promise<FixtureAnswer<{ ok: true; key_id: string; token: string } | Exclude<KeyCommandAnswer, { ok: true }>>> {
    if (caller !== FIXTURE_WORKLOAD) return { ok: false, reason: 'caller_not_allowed' };
    const minted = mintKey('shk');
    const tenant: Tenant = { kind: 'account', account };
    const a = await this.owner.issueKey({ tenant, key_id: minted.key_id, verifier: minted.verifier, actor: FIXTURE_ADMIN,
      caller, ...(opts.limits ? { limits: opts.limits } : {}), ...(opts.probe === undefined ? {} : { probe: opts.probe }) });
    return a.ok ? { ok: true, key_id: minted.key_id, token: minted.token } : a;
  }

  async revokeAgentKey(caller: string, account: string, key_id: string): Promise<FixtureAnswer<KeyCommandAnswer>> {
    if (caller !== FIXTURE_WORKLOAD) return { ok: false, reason: 'caller_not_allowed' };
    return this.owner.revokeKey({ tenant: { kind: 'account', account }, key_id, actor: FIXTURE_ADMIN, caller });
  }
}
