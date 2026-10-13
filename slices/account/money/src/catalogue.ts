/**
 * The split weights that settlement and the ledger read from the catalogue (C06 §2 `split_weights`). Each
 * version is kept by (route, weights version). A version never changes (C06 "Versions"): a second, different
 * body for one key is not applied and is reported.
 */
import type { SplitWeights } from './contracts/c06.ts';
import { digestOf } from './money.ts';
import type { WeightsSource } from './ledger/decide.ts';

export class SplitWeightsReplica implements WeightsSource {
  private readonly versions = new Map<string, { w: SplitWeights; digest: string }>();
  /** Keys that got a second, different body. */
  readonly conflicts: string[] = [];

  private static key(route: string, weightsVersion: string): string {
    return JSON.stringify([route, weightsVersion]);
  }

  /** Apply one `split_weights` entity from the catalogue feed. A repeat of the same body has no effect. */
  apply(w: SplitWeights): void {
    const k = SplitWeightsReplica.key(w.route, w.weightsVersion);
    const digest = digestOf(w);
    const cur = this.versions.get(k);
    if (cur && cur.digest !== digest) { this.conflicts.push(k); return; }
    this.versions.set(k, { w: structuredClone(w), digest });
  }

  find(route: string, weightsVersion: string): SplitWeights | undefined {
    return this.versions.get(SplitWeightsReplica.key(route, weightsVersion))?.w;
  }
}
