// Route reservations across several links as a saga (D13-D17).
//
//   1. Hold every leg: the partner leg first (most likely to fail, and it does
//      not understand our tickets), then our own links, busiest first.
//   2. Commit point: pin our holds (they can no longer be wounded or expire)
//      and record 'committing'. From here the saga rolls forward, never back.
//   3. Confirm the partner leg (the one participant we cannot pin), retrying
//      with the same key until it gives a definite answer.
//   4. Write every leg as a fact in one Postgres transaction.
//
// Failure before the commit point compensates: release every hold (idempotent,
// retried), and hold expiry is the backstop if the coordinator dies.

import pg from 'pg';
import { readFileSync } from 'node:fs';
import { LinkBook, type Ticket } from './links.ts';
import { PartnerLink, PartnerError } from './partner.ts';

export const BASE = Date.UTC(2026, 0, 1);
export const at = (minute: number) => new Date(BASE + minute * 60_000);
const minuteOf = (d: Date) => Math.round((d.getTime() - BASE) / 60_000);

export type RouteRequest = {
  idemKey: string;
  links: number[];
  s: number;
  e: number | null;
  mbps: number;
};

export type RouteResult =
  | { status: 'confirmed'; sagaId: number; restarts: number }
  | { status: 'rejected'; sagaId: number; linkId: number; conflicts: Array<[number, number]> }
  | { status: 'failed'; sagaId: number; reason: string }
  | { status: 'pending'; sagaId: number }
  | { status: 'crashed'; sagaId: number };

export type CrashPoint = 'after-first-hold' | 'after-commit-decision';

type Options = {
  holdTtlMs: number;
  deadlineMs: number;
  random: () => number;
  crashAt?: CrashPoint;
  beforeHold?: (sagaId: number, index: number) => Promise<void>; // test hook: force interleavings
};

class Crashed extends Error {}

type Saga = {
  id: number;
  ticket: Ticket;
  req: RouteRequest;
  attempt: number;
  restarts: number;
  keys: Map<number, string>; // link id -> hold key, current attempt
  wounded: boolean;
  wake: () => void;
};

type AttemptOutcome =
  | { kind: 'held' }
  | { kind: 'restart' }
  | { kind: 'reject'; linkId: number; conflicts: Array<[number, number]> };

const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, Math.max(0, ms)).unref());

const sameRequest = (a: RouteRequest, b: RouteRequest) =>
  a.links.join() === b.links.join() && a.s === b.s && a.e === b.e && a.mbps === b.mbps;

const keyReused = (req: RouteRequest) =>
  new Error(`idempotency key ${req.idemKey} reused for a different request`);

export async function resetRoutesSchema(db: pg.Pool): Promise<void> {
  await db.query('DROP TABLE IF EXISTS holds, sagas');
  await db.query(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  await db.query(readFileSync(new URL('../schema-routes.sql', import.meta.url), 'utf8'));
}

export class Coordinator {
  readonly books: Map<number, LinkBook>;
  readonly partner: PartnerLink;
  private db: pg.Pool;
  private opts: Options;
  private inflight = new Map<string, { req: RouteRequest; result: Promise<RouteResult> }>();
  readonly stats = { waits: 0, wounds: 0, restarts: 0 };
  private active = new Map<number, Saga>();
  private dead = false;

  constructor(db: pg.Pool, books: LinkBook[], partner: PartnerLink, opts: Options) {
    this.db = db;
    this.partner = partner;
    this.opts = opts;
    this.books = new Map(books.map((b) => [b.id, b]));
    for (const b of books) b.onWound = (sagaId) => this.wound(sagaId);
  }

  // Simulate the coordinator process dying: in-flight sagas stop where they are,
  // without compensating. Their in-memory link books are lost with it.
  crash(): void {
    this.dead = true;
    for (const s of this.active.values()) s.wake();
  }

  private alive(): void {
    if (this.dead) throw new Crashed();
  }

  private wound(sagaId: number): void {
    const s = this.active.get(sagaId);
    if (!s) return;
    s.wounded = true;
    this.stats.wounds++;
    s.wake();
  }

  // Idempotent: the same key returns the same saga's result, never a second booking.
  reserve(req: RouteRequest): Promise<RouteResult> {
    const running = this.inflight.get(req.idemKey);
    if (running) {
      if (!sameRequest(running.req, req)) return Promise.reject(keyReused(req));
      return running.result;
    }
    const result = this.run(req);
    this.inflight.set(req.idemKey, { req, result });
    return result;
  }

  private async run(req: RouteRequest): Promise<RouteResult> {
    const ticketMs = Date.now();
    const ins = await this.db.query(
      `INSERT INTO sagas (idem_key, ticket_ms, links, start_min, end_min, mbps, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'holding')
       ON CONFLICT (idem_key) DO NOTHING RETURNING id`,
      [req.idemKey, ticketMs, req.links, req.s, req.e, req.mbps],
    );
    if (ins.rowCount === 0) return this.existing(req);

    const id = Number(ins.rows[0].id);
    const saga: Saga = {
      id, ticket: [ticketMs, id], req, attempt: 0, restarts: 0,
      keys: new Map(), wounded: false, wake: () => {},
    };
    this.active.set(id, saga);
    try {
      return await this.drive(saga);
    } catch (err) {
      if (err instanceof Crashed) return { status: 'crashed', sagaId: id };
      throw err;
    } finally {
      this.active.delete(id);
    }
  }

  private async existing(req: RouteRequest): Promise<RouteResult> {
    const { rows } = await this.db.query(
      'SELECT id, links, start_min, end_min, mbps, result FROM sagas WHERE idem_key = $1',
      [req.idemKey],
    );
    const r = rows[0];
    const stored = { idemKey: req.idemKey, links: r.links.map(Number), s: r.start_min, e: r.end_min, mbps: r.mbps };
    if (!sameRequest(stored, req)) throw keyReused(req);
    return r.result ?? { status: 'pending', sagaId: Number(r.id) };
  }

  private async drive(saga: Saga): Promise<RouteResult> {
    const deadline = Date.now() + this.opts.deadlineMs;
    for (;;) {
      this.alive();
      if (Date.now() > deadline) {
        await this.releaseAll(saga);
        return this.finish(saga, 'failed', { status: 'failed', sagaId: saga.id, reason: 'deadline' });
      }
      saga.attempt++;
      saga.wounded = false;
      saga.keys = new Map(saga.req.links.map((l) => [l, `${saga.id}.${saga.attempt}.${l}`]));

      const held = await this.holdAll(saga, deadline);
      if (held.kind === 'reject') {
        await this.releaseAll(saga);
        return this.finish(saga, 'rejected', {
          status: 'rejected', sagaId: saga.id, linkId: held.linkId, conflicts: held.conflicts,
        });
      }
      if (held.kind === 'restart' || !this.pinOwnLegs(saga)) {
        await this.restart(saga);
        continue;
      }

      // Commit decision recorded: from here we roll forward.
      await this.db.query("UPDATE sagas SET status = 'committing' WHERE id = $1", [saga.id]);
      if (this.opts.crashAt === 'after-commit-decision') this.crash();
      this.alive();

      if (saga.req.links.includes(this.partner.id)) {
        const answer = await this.retry(() => this.partner.confirm(saga.keys.get(this.partner.id)!));
        if (answer === 'unknown-hold') {
          // The partner's hold expired before we confirmed: undo and start again.
          await this.restart(saga);
          continue;
        }
      }
      await this.writeFacts(saga);
      for (const [linkId, key] of saga.keys) this.books.get(linkId)?.confirm(key);
      return { status: 'confirmed', sagaId: saga.id, restarts: saga.restarts };
    }
  }

  private async restart(saga: Saga): Promise<void> {
    await this.releaseAll(saga);
    saga.restarts++;
    this.stats.restarts++;
    await this.db.query('UPDATE sagas SET restarts = $2 WHERE id = $1', [saga.id, saga.restarts]);
  }

  private ordered(saga: Saga): number[] {
    const { s, e } = saga.req;
    const busy = (id: number) => {
      const b = this.books.get(id)!;
      return b.total.peak(s, e ?? b.total.n) / b.capacity;
    };
    const own = saga.req.links.filter((l) => l !== this.partner.id).sort((a, b) => busy(b) - busy(a));
    return saga.req.links.includes(this.partner.id) ? [this.partner.id, ...own] : own;
  }

  private async holdAll(saga: Saga, deadline: number): Promise<AttemptOutcome> {
    for (const [index, linkId] of this.ordered(saga).entries()) {
      await this.opts.beforeHold?.(saga.id, index);
      const o = linkId === this.partner.id
        ? await this.holdPartner(saga, deadline)
        : await this.holdOwn(saga, linkId, deadline);
      if (o.kind !== 'held') return o;
      if (this.opts.crashAt === 'after-first-hold') this.crash();
    }
    return { kind: 'held' };
  }

  private async holdOwn(saga: Saga, linkId: number, deadline: number): Promise<AttemptOutcome> {
    const book = this.books.get(linkId)!;
    const key = saga.keys.get(linkId)!;
    const { s, e, mbps } = saga.req;
    for (;;) {
      this.alive();
      if (saga.wounded || Date.now() > deadline) return { kind: 'restart' };
      const o = book.tryHold({ key, sagaId: saga.id, ticket: saga.ticket, s, e, mbps }, this.opts.holdTtlMs);
      if (o.kind === 'held') {
        await this.recordHold(saga, linkId, key, book.holds.get(key)?.expiresAt ?? Date.now());
        return o;
      }
      if (o.kind === 'reject') return { kind: 'reject', linkId, conflicts: o.conflicts };
      // Fits only if holds release: wait on our side (D16), never reject.
      this.stats.waits++;
      const wakeAt = Math.min(book.nextExpiry(), deadline);
      await Promise.race([
        book.changed(),
        new Promise<void>((r) => (saga.wake = r)),
        sleep(wakeAt - Date.now() + 1),
      ]);
    }
  }

  private async holdPartner(saga: Saga, deadline: number): Promise<AttemptOutcome> {
    const key = saga.keys.get(this.partner.id)!;
    const { s, e, mbps } = saga.req;
    for (;;) {
      this.alive();
      if (Date.now() > deadline) return { kind: 'restart' };
      const answer = await this.retry(() => this.partner.hold(key, s, e, mbps, this.opts.holdTtlMs));
      if (answer === 'held') {
        await this.recordHold(saga, this.partner.id, key, Date.now() + this.opts.holdTtlMs);
        return { kind: 'held' };
      }
      if (answer === 'nofit') return { kind: 'reject', linkId: this.partner.id, conflicts: [] };
      await sleep(5 + this.opts.random() * 15); // busy: the partner cannot queue us, so poll
    }
  }

  // Pin is synchronous across all our links, so no hold can be wounded or
  // expire between the check and the pin.
  private pinOwnLegs(saga: Saga): boolean {
    const own = [...saga.keys].filter(([l]) => l !== this.partner.id);
    if (!own.every(([l, k]) => this.books.get(l)!.has(k))) return false;
    for (const [l, k] of own) this.books.get(l)!.pin(k);
    return true;
  }

  private async releaseAll(saga: Saga): Promise<void> {
    for (const [linkId, key] of saga.keys) {
      if (linkId === this.partner.id) await this.retry(() => this.partner.release(key));
      else this.books.get(linkId)!.release(key);
    }
    await this.db.query(
      "UPDATE holds SET status = 'released' WHERE saga_id = $1 AND status = 'held'",
      [saga.id],
    );
  }

  // Partner calls are idempotent by key, so any error or timeout is retried as-is.
  private async retry<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      this.alive();
      try {
        return await call();
      } catch (err) {
        if (!(err instanceof PartnerError)) throw err;
        await sleep(Math.min(50, 2 ** attempt) * this.opts.random());
      }
    }
  }

  private async recordHold(saga: Saga, linkId: number, key: string, expiresAt: number) {
    const { s, e, mbps } = saga.req;
    await this.db.query(
      `INSERT INTO holds (key, saga_id, link_id, start_min, end_min, mbps, expires_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'held') ON CONFLICT (key) DO NOTHING`,
      [key, saga.id, linkId, s, e, mbps, expiresAt],
    );
  }

  // Every leg becomes a fact in one transaction, together with the saga's result.
  private async writeFacts(saga: Saga): Promise<void> {
    const { s, e, mbps } = saga.req;
    const result = { status: 'confirmed', sagaId: saga.id, restarts: saga.restarts };
    const c = await this.db.connect();
    try {
      await c.query('BEGIN');
      for (const linkId of saga.req.links) {
        await c.query(
          'INSERT INTO reservations (link_id, start_time, end_time, reserved_mbps) VALUES ($1, $2, $3, $4)',
          [linkId, at(s), e === null ? null : at(e), mbps],
        );
      }
      await c.query(
        "UPDATE holds SET status = 'confirmed' WHERE saga_id = $1 AND key = ANY($2)",
        [saga.id, [...saga.keys.values()]],
      );
      await c.query("UPDATE sagas SET status = 'confirmed', result = $2 WHERE id = $1", [saga.id, result]);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
  }

  // Finish a saga that recorded its commit decision before the coordinator died.
  async rollForward(row: any, holdRows: any[]): Promise<void> {
    const id = Number(row.id);
    const saga: Saga = {
      id, ticket: [Number(row.ticket_ms), id],
      req: { idemKey: row.idem_key, links: row.links.map(Number), s: row.start_min, e: row.end_min, mbps: row.mbps },
      attempt: 0, restarts: row.restarts, wounded: false, wake: () => {},
      keys: new Map(holdRows.map((h) => [Number(h.link_id), h.key as string])),
    };
    const partnerKey = saga.keys.get(this.partner.id);
    if (partnerKey) {
      const answer = await this.retry(() => this.partner.confirm(partnerKey));
      if (answer === 'unknown-hold') {
        await this.releaseAll(saga);
        await this.finish(saga, 'failed', { status: 'failed', sagaId: id, reason: 'partner hold expired before recovery' });
        return;
      }
    }
    await this.writeFacts(saga);
    for (const [linkId, key] of saga.keys) this.books.get(linkId)?.confirm(key);
  }

  private async finish(saga: Saga, status: string, result: RouteResult): Promise<RouteResult> {
    await this.db.query('UPDATE sagas SET status = $2, result = $3 WHERE id = $1', [saga.id, status, result]);
    return result;
  }
}

// Rebuild after a coordinator crash, from the facts and the saga log.
//   - Confirmed reservations are loaded as they are.
//   - 'holding' sagas made no commit decision: their holds are restored with
//     their original expiry and left to expire (the backstop), and the saga fails.
//   - 'committing' sagas made the decision: roll forward by confirming the
//     partner leg (same key, so a confirm that already happened is a no-op)
//     and writing the facts.
export async function recover(
  db: pg.Pool, partner: PartnerLink, n: number, opts: Options,
): Promise<Coordinator> {
  const links = await db.query('SELECT id, capacity_mbps FROM links WHERE id <> $1', [partner.id]);
  const books = links.rows.map((r) => new LinkBook(Number(r.id), r.capacity_mbps, n));
  const byId = new Map(books.map((b) => [b.id, b]));

  const facts = await db.query('SELECT link_id, start_time, end_time, reserved_mbps FROM reservations');
  for (const f of facts.rows) {
    byId.get(Number(f.link_id))?.addConfirmed(
      minuteOf(f.start_time), f.end_time === null ? null : minuteOf(f.end_time), f.reserved_mbps,
    );
  }

  const holds = await db.query(
    `SELECT h.*, s.status AS saga_status, s.ticket_ms
       FROM holds h JOIN sagas s ON s.id = h.saga_id
      WHERE h.status = 'held' AND s.status IN ('holding', 'committing')`,
  );
  for (const h of holds.rows) {
    const book = byId.get(Number(h.link_id));
    if (!book) continue; // the partner leg lives in the partner's system
    book.restoreHold({
      key: h.key, sagaId: Number(h.saga_id), ticket: [Number(h.ticket_ms), Number(h.saga_id)],
      s: h.start_min, e: h.end_min, mbps: h.mbps, expiresAt: Number(h.expires_at),
      pinned: h.saga_status === 'committing',
    });
  }

  const coord = new Coordinator(db, books, partner, { ...opts, crashAt: undefined });
  await db.query(
    `UPDATE sagas SET status = 'failed',
            result = jsonb_build_object('status', 'failed', 'sagaId', id, 'reason', 'coordinator crashed')
      WHERE status = 'holding'`,
  );
  const committing = await db.query("SELECT * FROM sagas WHERE status = 'committing'");
  for (const s of committing.rows) {
    await coord.rollForward(s, holds.rows.filter((h) => h.saga_id === s.id));
  }
  return coord;
}
