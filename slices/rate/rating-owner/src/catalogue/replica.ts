/**
 * A consumer's full replica of `catalogue.v1` (C06 §2 "All catalogue consumers. Each consumer
 * keeps a full replica"). Applies each (entity, entityVersion) once, in any order of arrival,
 * and keeps the latest resolved timestamp (`CataloguePosition`).
 */
import type { FeedEvent, HlcTs } from '@share/owner-runtime';
import { compareHlc, decodeJson } from '@share/owner-runtime';
import { parseMinute, type CatalogueEntity, type CatalogueEvent, type CataloguePosition } from '@share/rate-common';

type PriceVersion = Extract<CatalogueEntity, { entityType: 'price_version' }>;
type SplitWeights = Extract<CatalogueEntity, { entityType: 'split_weights' }>;
type Product = Extract<CatalogueEntity, { entityType: 'product' }>;

export class CatalogueReplica {
  private readonly applied = new Map<string, bigint>();
  private readonly products = new Map<string, Product>();
  private readonly prices: PriceVersion[] = [];
  private readonly weights: SplitWeights[] = [];
  private resolved: HlcTs | undefined;

  applyEvent(ev: CatalogueEvent): void {
    const key = ev.eventId.partition;
    const v = BigInt(ev.entityVersion);
    if ((this.applied.get(key) ?? 0n) >= v) return;
    this.applied.set(key, v);
    const b = ev.body;
    if (b.entityType === 'product') this.products.set(b.productId, b);
    else if (b.entityType === 'price_version') this.prices.push(b);
    else if (b.entityType === 'split_weights') this.weights.push(b);
  }

  applyFeedEvent(e: FeedEvent): void {
    this.applyEvent(decodeJson(e.value) as CatalogueEvent);
  }

  onResolved(R: HlcTs): void {
    if (this.resolved === undefined || compareHlc(R, this.resolved) > 0) this.resolved = R;
  }

  position(): CataloguePosition {
    return { resolvedTs: this.resolved ?? '0.0000000000' };
  }

  productKind(productId: string): 'guaranteed' | 'best_effort' | undefined {
    return this.products.get(productId)?.kind;
  }

  /** The `usage_price` in force for the minute (the latest `effectiveFrom` at or before it), in pico-USD per GB. */
  usagePriceAt(product: string, route: string, minuteMs: number): { price: bigint; priceVersion: string } | undefined {
    let best: PriceVersion | undefined;
    for (const p of this.prices) {
      if (p.product !== product || p.route !== route || p.priceKind !== 'usage_price') continue;
      const from = parseMinute(p.effectiveFrom);
      if (from > minuteMs) continue;
      if (!best || from > parseMinute(best.effectiveFrom)) best = p;
    }
    return best ? { price: BigInt(best.price), priceVersion: best.priceVersion } : undefined;
  }

  /** The split weights in force for the route at the minute (C06 "Routes and weights"). */
  weightsAt(route: string, minuteMs: number): SplitWeights | undefined {
    let best: SplitWeights | undefined;
    for (const w of this.weights) {
      if (w.route !== route) continue;
      const from = parseMinute(w.effectiveFrom);
      if (from > minuteMs) continue;
      if (!best || from > parseMinute(best.effectiveFrom)) best = w;
    }
    return best;
  }

  weightsVersion(version: string): SplitWeights | undefined {
    return this.weights.find((w) => w.weightsVersion === version);
  }
}
