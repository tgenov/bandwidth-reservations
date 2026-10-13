/**
 * The owner's catalogue cache (C06 §2) and the link registry rules it needs at intake (C13).
 * The cache applies catalogue events by entity version. It answers the route of a list of legs,
 * whether a product is sold on a route, and the reservation price in force at a minute.
 */
import { compareHlc, hlc } from '@share/owner-runtime';
import type { CatalogueEvent } from '../contracts/c06.ts';

export interface LinkRules { linkId: string; capacityMbps: number; probe: boolean }

interface PriceRow { priceVersion: string; price: bigint; effectiveFrom: bigint }

export function minuteOfIso(iso: string): bigint {
  return BigInt(Math.floor(Date.parse(iso) / 60_000));
}

export class CatalogueCache {
  private readonly routes = new Map<string, { routeId: string; legs: string[] }>();
  private readonly products = new Map<string, { kind: string }>();
  private readonly prices = new Map<string, PriceRow[]>();
  private readonly links = new Map<string, LinkRules>();
  private readonly versions = new Map<string, bigint>();
  /** The feed resolved timestamp the cache has applied (C06 CataloguePosition). */
  resolvedTs = '0.0000000000';

  apply(e: CatalogueEvent): void {
    const b = e.body;
    const id = b.entityType === 'product' ? `product|${b.productId}`
      : b.entityType === 'route' ? `route|${b.routeId}`
        : `price|${b.product}|${b.route}|${b.priceKind}|${b.priceVersion}`;
    const v = BigInt(e.entityVersion);
    const cur = this.versions.get(id);
    if (cur !== undefined && cur >= v) return;
    this.versions.set(id, v);
    if (b.entityType === 'product') this.products.set(b.productId, { kind: b.kind });
    else if (b.entityType === 'route') this.routes.set(b.legs.join('>'), { routeId: b.routeId, legs: [...b.legs] });
    else if (b.priceKind === 'reservation_price') {
      const k = `${b.product}|${b.route}`;
      const rows = (this.prices.get(k) ?? []).filter((r) => r.priceVersion !== b.priceVersion);
      rows.push({ priceVersion: b.priceVersion, price: BigInt(b.price), effectiveFrom: minuteOfIso(b.effectiveFrom) });
      rows.sort((x, y) => (x.effectiveFrom < y.effectiveFrom ? -1 : x.effectiveFrom > y.effectiveFrom ? 1 : 0));
      this.prices.set(k, rows);
    }
    if (compareHlc(hlc(e.committedAt), hlc(this.resolvedTs)) > 0) this.resolvedTs = hlc(e.committedAt);
  }

  setLink(rules: LinkRules): void {
    this.links.set(rules.linkId, rules);
  }

  link(linkId: string): LinkRules | undefined {
    return this.links.get(linkId);
  }

  routeOf(legs: string[]): { routeId: string; legs: string[] } | undefined {
    return this.routes.get(legs.join('>'));
  }

  productSold(product: string, routeId: string): boolean {
    return this.products.has(product) && (this.prices.get(`${product}|${routeId}`)?.length ?? 0) > 0;
  }

  /** The reservation price in force at minute m (the latest version with effectiveFrom ≤ m). */
  priceAt(product: string, routeId: string, m: bigint): { priceVersion: string; price: bigint } | undefined {
    let found: PriceRow | undefined;
    for (const r of this.prices.get(`${product}|${routeId}`) ?? []) if (r.effectiveFrom <= m) found = r;
    return found ? { priceVersion: found.priceVersion, price: found.price } : undefined;
  }
}
