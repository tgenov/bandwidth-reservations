/**
 * Status reads (C10 `status`, RFC-002 §8.2). This is an in-process stand-in for the account kind's
 * status readers: the C01 status-reader runtime (read leases, `leasedRead`, `replicaRule3Check`) is
 * S-PLAT I1b, and the readers themselves are ACCT-I4. It keeps the C10 guarantees:
 * - an outcome is answered only when it is reported, so a read never contradicts the decision;
 * - after a reported outcome every read answers it, also without a lease (rule 1);
 * - `pending` only under a live lease (rule 2); otherwise 503 (rule 4), never a guess.
 */
import type { OwnerRuntime } from '@share/owner-runtime';
import type { PrincipalContext } from '../contracts/c08.ts';
import type { C10Answer } from '../contracts/c10.ts';
import type { AccountOwner } from './owner.ts';

export class StatusReader {
  private readonly owner: AccountOwner;
  private readonly rt: OwnerRuntime;
  constructor(owner: AccountOwner, rt: OwnerRuntime) {
    this.owner = owner;
    this.rt = rt;
  }

  status(account: string, principal: PrincipalContext, key: string): C10Answer {
    const refused = this.owner.principalCheck(account, principal);
    if (refused) return refused;
    const req = this.owner.committedRequest(account, key);
    // "No such request" only when the committed index has no row for the key (RFC-002 §8.2, unknown key).
    if (!req) return { http: 404, body: { error: 'not_found' } };
    if (req.principal !== principal.principal_id) return { http: 409, body: { error: 'not_accepted', code: 'key_reuse_other_principal' } };
    if (this.owner.reportedFor(account, req)) return { http: 200, body: this.owner.statusBody(req, true) };
    const st = this.owner.accountState(account);
    if (st && this.rt.leaseValid(st.slot).valid) return { http: 202, body: this.owner.statusBody(req, false) };
    return { http: 503, body: { error: 'temporarily_unavailable' }, retryAfterS: 1 };
  }
}
