/**
 * The catalogue (RFC-003 §6; C06 §2), I1 scope: product, route, `usage_price` and split
 * weights from a deployment fixture, published on `catalogue.v1` with resolved markers.
 * Lead-time rules are checked at the commit timestamp of the entry (C06 "Lead times").
 */
import type { BatchContext, Epoch, Generation, InboundNotification, OwnerHooks, OwnerRuntime, PartitionKey, SlotNo } from '@share/owner-runtime';
import { hlcToWallMs, utf8 } from '@share/owner-runtime';
import {
  RATE_PARAMS, appendWithPolicy, ceilMin, entityKey, identityOf, isPicoUsd, parseMinute, serviceAudit,
  type AlertSink, type CatalogueEntity, type CatalogueEvent,
} from '@share/rate-common';
import { CATALOGUE_ENTRY } from './declaration.ts';

/** An entity as a deployment fixture gives it: `announcedAt` is the commit timestamp, so the owner sets it. */
export type FixtureEntity =
  | Exclude<CatalogueEntity, { entityType: 'price_version' } | { entityType: 'split_weights' }>
  | Omit<Extract<CatalogueEntity, { entityType: 'price_version' }>, 'announcedAt'>
  | Omit<Extract<CatalogueEntity, { entityType: 'split_weights' }>, 'announcedAt'>;

export type WriteAnswer = { ok: true; event: CatalogueEvent } | { ok: false; reason: string };

export interface CatalogueOptions { alerts?: AlertSink; sleep?: (ms: number) => Promise<void> }

/** Why the version is refused at commit timestamp `tsMs`, or undefined (C06 "Lead times"). */
export function leadTimeRefusal(e: FixtureEntity, tsMs: number): string | undefined {
  if (e.entityType === 'price_version') {
    if (!isPicoUsd(e.price)) return 'price is not an integer pico-USD string';
    const from = parseMinute(e.effectiveFrom);
    if (from < ceilMin(tsMs + 60_000)) return 'effectiveFrom is less than 1 min after announcedAt';
    if (e.priceKind === 'usage_price' && from < ceilMin(tsMs + RATE_PARAMS.priceNoticeMs)) return 'usage_price lead is less than price_notice';
  }
  if (e.entityType === 'split_weights') {
    if (parseMinute(e.effectiveFrom) < ceilMin(tsMs + 60_000)) return 'effectiveFrom is less than 1 min after announcedAt';
    if (e.commissionWeight <= 0 || !Number.isInteger(e.commissionWeight)) return 'commission weight is not a positive integer';
    if (e.legs.some((l) => l.weight <= 0 || !Number.isInteger(l.weight))) return 'a weight is not a positive integer';
  }
  return undefined;
}

export class CatalogueOwner implements OwnerHooks {
  private readonly rt: OwnerRuntime;
  private readonly opts: CatalogueOptions;
  /** Entity key to its last version number (memory of the lease holder). */
  private readonly versions = new Map<string, bigint>();

  constructor(rt: OwnerRuntime, opts: CatalogueOptions = {}) {
    this.rt = rt;
    this.opts = opts;
  }

  async onAcquire(_s: SlotNo, _e: Epoch): Promise<void> {}
  onRelease(_s: SlotNo): void {}
  onReportable(): void {}
  onMovedOut(): void {}
  async onAdopt(_p: PartitionKey, _g: Generation): Promise<void> {}
  async onNotification(_n: InboundNotification): Promise<void> {}

  /** Write one version from a deployment (C06 D6: deployments write fixtures; no console command here). */
  async write(entity: FixtureEntity, deployment: string): Promise<WriteAnswer> {
    const key = entityKey(entity as CatalogueEntity);
    const partition = utf8(key);
    let event: CatalogueEvent | undefined;
    let refusal: string | undefined;
    const identity = identityOf('catalogue.version', key, deployment, JSON.stringify(entity));
    const out = await appendWithPolicy(this.rt, {
      partition,
      decide: (ctx: BatchContext) => {
        const why = leadTimeRefusal(entity, hlcToWallMs(ctx.ts));
        if (why) { refusal = why; return null; }
        const head = ctx.head(partition);
        const body = (entity.entityType === 'price_version' || entity.entityType === 'split_weights'
          ? { ...entity, announcedAt: ctx.ts } : entity) as CatalogueEntity;
        const entityVersion = head.seq + 1n;
        event = {
          type: 'CatalogueEvent', schemaVersion: 1,
          eventId: { partition: key, stream: 'catalogue', streamSeq: ((head.streams['catalogue'] ?? 0n) + 1n).toString(),
            generation: head.generation, epoch: Number(this.rt.epoch(this.rt.route('catalogue', partition).slot)) },
          entityVersion: entityVersion.toString(), committedAt: ctx.ts, principal: deployment, body,
        };
        return {
          entries: [{ kind: CATALOGUE_ENTRY.version, schemaV: 1, identity, audit: serviceAudit(deployment), payload: event,
            emits: [{ stream: 'catalogue', event }] }],
          projections: [{ table: 'catalogue_entity', op: 'upsert', key: { partition }, row: { entity_version: entityVersion, body } }],
        };
      },
    }, undefined, { owner: 'catalogue', ...(this.opts.alerts ? { alerts: this.opts.alerts } : {}), ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}) });
    if (out.ok && event) {
      this.versions.set(key, BigInt(event.entityVersion));
      return { ok: true, event };
    }
    if (!out.ok && out.why === 'conditionFailed' && refusal) return { ok: false, reason: refusal };
    return { ok: false, reason: out.ok ? 'no event' : out.why };
  }
}
