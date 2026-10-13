/**
 * C06 v1 (frozen): the parts the account owner reads in AM-I1. The catalogue (§2: product, route,
 * reservation price) and the ledger movement feed, by-buyer view (§9). Names are copied from C06.
 */

export type MicroUsd = string;
export type PicoUsd = string;
export type DbTs = string;
export type Minute = string;
export type Seq = string;
export type LinkId = string;
export type ProductId = string;
export type RouteId = string;

export interface EventId { partition: string; stream: string; streamSeq: Seq; generation: number; epoch: number }

export interface LedgerPosition { ledgerPartition: string; sequence: Seq; commitTs: DbTs }

export type CatalogueEntity =
  | { entityType: 'product'; productId: ProductId; kind: 'guaranteed' | 'best_effort'; permitsBurst: boolean }
  | { entityType: 'route'; routeId: RouteId; legs: LinkId[]; equivalentPathOf?: RouteId }
  | { entityType: 'price_version'; product: ProductId; route: RouteId;
      priceKind: 'reservation_price' | 'usage_price';
      priceVersion: string;
      price: PicoUsd;
      effectiveFrom: Minute;
      announcedAt: DbTs;
      oeEffective?: Minute };

export interface CatalogueEvent {
  type: 'CatalogueEvent'; schemaVersion: 1;
  eventId: EventId;
  entityVersion: Seq;
  committedAt: DbTs;
  principal: string;
  body: CatalogueEntity;
}

export const MOVEMENT_FEED_TOPIC = 'ledger.movements.by-buyer.v1';

export interface MovementPosted {
  type: 'MovementPosted'; schemaVersion: 1;
  eventId: EventId;
  movementId: string;
  position: LedgerPosition;
  postingTime: DbTs;
  movementRef: string;
  home: { account?: string; supplier?: string; shareSubPartition?: number };
  kinds: string[];
  cause: string;
  currency: 'USD';
  partyTotals: Array<{ ledgerAccount: string; amount: MicroUsd }>;
  lines: Array<{ kind: string; outcome: 'posted' | 'duplicate' | 'excluded'; nil: boolean; amount?: MicroUsd }>;
  postedThrough?: Array<{ reservation: string; minute: Minute }>;
  feesPosted?: Array<{ reservation: string; feeId: string }>;
  buyer?: { account: string; balanceAfter: MicroUsd; writtenOffOwedAfter: MicroUsd };
}
