/**
 * C06 CT-R1 schema checks for the messages that rating emits in I1 (figures and charge-line
 * batches). Each function returns a list of errors; an empty list means the message agrees
 * with C06 v1. Money and prices must be integer strings.
 */
import {
  LINE_KINDS, MOVEMENT_LIMIT, REASONS, canonicalSourceRefBytes, isDbTs, isMicroUsd, isSeq,
  type ChargeLine, type ChargeLineBatch, type EventId, type UnpostedUsageFigure,
} from './c06.ts';
import { isMinute } from './time.ts';

function checkEventId(e: EventId | undefined, errors: string[], at: string): void {
  if (!e) { errors.push(`${at}: eventId missing`); return; }
  if (typeof e.partition !== 'string' || e.partition === '') errors.push(`${at}.partition`);
  if (typeof e.stream !== 'string' || e.stream === '') errors.push(`${at}.stream`);
  if (!isSeq(e.streamSeq)) errors.push(`${at}.streamSeq is not a decimal string`);
  if (!Number.isInteger(e.generation)) errors.push(`${at}.generation`);
  if (!Number.isInteger(e.epoch)) errors.push(`${at}.epoch`);
}

function checkMoney(v: unknown, errors: string[], at: string): void {
  if (!isMicroUsd(v)) errors.push(`${at} is not an integer micro-USD string: ${String(v)}`);
}

export function checkFigure(f: UnpostedUsageFigure): string[] {
  const errors: string[] = [];
  if (f.type !== 'UnpostedUsageFigure' || f.schemaVersion !== 1) errors.push('type/schemaVersion');
  checkEventId(f.eventId, errors, 'eventId');
  if (typeof f.account !== 'string') errors.push('account');
  const rp = f.ratingPosition;
  if (!rp || typeof rp.ratingPartition !== 'string' || !Number.isInteger(rp.generation) || !isSeq(rp.seq)) errors.push('ratingPosition');
  const x = f.ledgerPositionX;
  if (!x || typeof x.ledgerPartition !== 'string' || !isSeq(x.sequence) || !isDbTs(x.commitTs)) errors.push('ledgerPositionX');
  for (const [i, p] of f.products.entries()) {
    checkMoney(p.unpostedUsage, errors, `products[${i}].unpostedUsage`);
    if (p.unpostedUsage.startsWith('-')) errors.push(`products[${i}].unpostedUsage < 0`);
    if ((p.usageReduction !== undefined) !== (f.inFlightUsageBatch !== undefined)) errors.push(`products[${i}].usageReduction iff inFlightUsageBatch`);
    if (p.usageReduction !== undefined) {
      checkMoney(p.usageReduction, errors, `products[${i}].usageReduction`);
      if (p.usageReduction.startsWith('-')) errors.push(`products[${i}].usageReduction < 0`);
    }
  }
  if (!isDbTs(f.publishedAt)) errors.push('publishedAt');
  if ('latenessBound' in (f as object)) errors.push('C06 §3 has no lateness-bound field');
  return errors;
}

export function checkChargeLine(l: ChargeLine, at = 'line'): string[] {
  const errors: string[] = [];
  try { canonicalSourceRefBytes(l.sourceRef); } catch (e) { errors.push(`${at}.sourceRef: ${(e as Error).message}`); }
  if (!LINE_KINDS.includes(l.lineKind)) errors.push(`${at}.lineKind`);
  if (!REASONS.includes(l.reason)) errors.push(`${at}.reason`);
  checkMoney(l.amount, errors, `${at}.amount`);
  checkMoney(l.newTotal, errors, `${at}.newTotal`);
  checkMoney(l.priorTotal, errors, `${at}.priorTotal`);
  if (isMicroUsd(l.amount) && isMicroUsd(l.newTotal) && isMicroUsd(l.priorTotal)
    && BigInt(l.amount) !== BigInt(l.newTotal) - BigInt(l.priorTotal)) errors.push(`${at}: amount ≠ newTotal − priorTotal`);
  const seq = 'seq' in l.sourceRef ? l.sourceRef.seq : 0;
  if (seq === 0 && l.reason !== 'original') errors.push(`${at}: a seq 0 line has reason original (m5)`);
  if (seq === 0 && l.priorTotal !== '0') errors.push(`${at}: an original has priorTotal "0"`);
  const feeKind = l.lineKind === 'fee' || l.lineKind === 'share_borne_fee';
  if (!feeKind) {
    if (l.route === undefined) errors.push(`${at}.route is necessary except for fee kinds`);
    if (l.weightsVersion === undefined) errors.push(`${at}.weightsVersion is necessary except for fee kinds`);
    if (l.minute === undefined || !isMinute(l.minute)) errors.push(`${at}.minute`);
  }
  if ((l.payee !== undefined) !== feeKind) errors.push(`${at}.payee iff fee kind`);
  if (l.payer !== 'account' && l.payer !== 'share') errors.push(`${at}.payer`);
  if ((l.lateCut !== undefined) !== (l.reason === 'late_pol07_cut')) errors.push(`${at}.lateCut iff late_pol07_cut`);
  if (!l.priceCatalogue || !isDbTs(l.priceCatalogue.resolvedTs)) errors.push(`${at}.priceCatalogue`);
  if (l.lineKind === 'usage' && l.sourceRef.kind === 'usage') {
    if (l.sourceRef.account !== l.account || l.sourceRef.product !== l.product || l.sourceRef.route !== l.route
      || l.sourceRef.minute !== l.minute) errors.push(`${at}: the usage SourceRef does not agree with the line`);
  }
  return errors;
}

export function checkChargeLineBatch(b: ChargeLineBatch): string[] {
  const errors: string[] = [];
  if (b.type !== 'ChargeLineBatch' || b.schemaVersion !== 1) errors.push('type/schemaVersion');
  checkEventId(b.eventId, errors, 'eventId');
  if (b.batch.lineCount !== b.lines.length) errors.push('batch.lineCount ≠ lines.length');
  if (b.lines.length < 1 || b.lines.length > MOVEMENT_LIMIT) errors.push('lines: 1 … 5,000');
  const hasUsage = b.lines.some((l) => l.lineKind === 'usage');
  if (b.batch.kind === 'usage' && b.batch.gated !== hasUsage) errors.push('batch.gated iff the usage batch holds a usage line');
  const keys = new Set<string>();
  for (const [i, l] of b.lines.entries()) {
    errors.push(...checkChargeLine(l, `lines[${i}]`));
    if (l.account !== b.batch.account) errors.push(`lines[${i}].account ≠ batch.account`);
    const { seq: _s, ...key } = l.sourceRef as { seq?: number };
    const k = JSON.stringify(key);
    if (keys.has(k)) errors.push(`lines[${i}]: two sequences of one line key in one batch (D2)`);
    keys.add(k);
  }
  if (!isDbTs(b.emittedAt)) errors.push('emittedAt');
  return errors;
}
