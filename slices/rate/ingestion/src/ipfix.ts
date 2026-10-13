/**
 * IPFIX (RFC 7011) decoder and encoder for the Share metering template (C11 Part I).
 *
 * Decoding uses only the templates and options of the item: first the context, then the
 * message itself (C11 F41-01). Templates of earlier items or sessions are never used.
 */
import type { RejectReason, ServiceTag, TemplateRefusal } from '@share/rate-common';

export const IPFIX_VERSION = 10;
const SET_TEMPLATE = 2;
const SET_OPTIONS_TEMPLATE = 3;
const VARIABLE = 0xffff;

/** Information elements of the Share metering template (C11 Part I table). */
export const IE = {
  octetDeltaCount: 1, packetDeltaCount: 2, ingressInterface: 10, egressInterface: 14,
  flowEndSysUpTime: 21, flowStartSysUpTime: 22, postOctetDeltaCount: 23, postPacketDeltaCount: 24,
  vlanId: 58, flowDirection: 61, mplsTopLabelStackSection: 70, exportingProcessId: 144,
  observationDomainId: 149, flowStartMilliseconds: 152, flowEndMilliseconds: 153,
  systemInitTimeMilliseconds: 160, ingressVRFID: 234, VRFname: 236, dot1qVlanId: 243, dot1qCustomerVlanId: 245,
} as const;

/** The fields a data template may declare (C11 Part I). Any other field refuses the template. */
const DATA_TEMPLATE_FIELDS = new Set<number>([
  IE.flowStartMilliseconds, IE.flowStartSysUpTime, IE.flowEndMilliseconds, IE.flowEndSysUpTime,
  IE.octetDeltaCount, IE.postOctetDeltaCount, IE.packetDeltaCount, IE.postPacketDeltaCount,
  IE.ingressInterface, IE.egressInterface, IE.flowDirection, IE.vlanId, IE.dot1qVlanId, IE.dot1qCustomerVlanId,
  IE.mplsTopLabelStackSection, IE.ingressVRFID, IE.VRFname,
]);

export interface FieldSpec { id: number; length: number; enterprise?: number }
export interface Template { id: number; fields: FieldSpec[]; scopeCount?: number }

export interface MessageHeader { version: number; length: number; exportTimeS: number; sequence: number; observationDomain: number }

export interface DataRecord {
  /** Position of the set in the message (0-based). */
  set: number;
  /** Position of the record in the set (0-based). */
  record: number;
  /** Position of the record among the data records of the message (0-based): i of the identity. */
  index: number;
  byteOffset: number;
  byteLength: number;
  templateId: number;
  values: Map<number, Uint8Array>;
}

export interface DecodedItem {
  header: MessageHeader;
  records: DataRecord[];
  templateRefusals: TemplateRefusal[];
  /** Data sets with no usable template (not in the context or the message, or refused). */
  noTemplateSets: Array<{ set: number; byteOffset: number }>;
  /** The distinct init times (IE 160) that applicable options records give for the domain. */
  initTimesMs: number[];
  /** Options fields other than the scope and IE 160 were present in the context or message. */
  otherOptionsFields: boolean;
}

export type DecodeResult = { ok: true; item: DecodedItem } | { ok: false; reason: 'unparseable'; detail: string };

class Reader {
  readonly b: Buffer;
  o: number;
  constructor(b: Buffer, o = 0) { this.b = b; this.o = o; }
  u8(): number { const v = this.b.readUInt8(this.o); this.o += 1; return v; }
  u16(): number { const v = this.b.readUInt16BE(this.o); this.o += 2; return v; }
  u32(): number { const v = this.b.readUInt32BE(this.o); this.o += 4; return v; }
}

function parseHeader(b: Buffer, at: number): MessageHeader {
  if (b.length - at < 16) throw new Error('short message header');
  const r = new Reader(b, at);
  const h = { version: r.u16(), length: r.u16(), exportTimeS: r.u32(), sequence: r.u32(), observationDomain: r.u32() };
  if (h.version !== IPFIX_VERSION) throw new Error(`version ${h.version} is not IPFIX`);
  if (h.length < 16 || at + h.length > b.length) throw new Error('message length out of range');
  return h;
}

function parseTemplateRecords(b: Buffer, start: number, end: number, options: boolean): Template[] {
  const out: Template[] = [];
  const r = new Reader(b, start);
  while (end - r.o >= 4) {
    const id = r.u16();
    const fieldCount = r.u16();
    if (fieldCount === 0) continue; // a withdrawal
    let scopeCount: number | undefined;
    if (options) scopeCount = r.u16();
    const fields: FieldSpec[] = [];
    for (let i = 0; i < fieldCount; i++) {
      if (end - r.o < 4) throw new Error('short template record');
      let fid = r.u16();
      const length = r.u16();
      let enterprise: number | undefined;
      if (fid & 0x8000) { fid &= 0x7fff; enterprise = r.u32(); }
      fields.push(enterprise === undefined ? { id: fid, length } : { id: fid, length, enterprise });
    }
    out.push(scopeCount === undefined ? { id, fields } : { id, fields, scopeCount });
  }
  return out;
}

function readRecord(b: Buffer, at: number, end: number, t: Template): { values: Map<number, Uint8Array>; next: number } | null {
  const values = new Map<number, Uint8Array>();
  let o = at;
  for (const f of t.fields) {
    let len = f.length;
    if (len === VARIABLE) {
      if (o + 1 > end) return null;
      len = b.readUInt8(o); o += 1;
      if (len === 255) { if (o + 2 > end) return null; len = b.readUInt16BE(o); o += 2; }
    }
    if (o + len > end) return null;
    if (f.enterprise === undefined) values.set(f.id, new Uint8Array(b.subarray(o, o + len)));
    o += len;
  }
  return { values, next: o };
}

function minRecordLength(t: Template): number {
  return t.fields.reduce((n, f) => n + (f.length === VARIABLE ? 1 : f.length), 0);
}

export function uint(v: Uint8Array | undefined): bigint | undefined {
  if (v === undefined || v.length === 0 || v.length > 8) return undefined;
  let x = 0n;
  for (const byte of v) x = (x << 8n) | BigInt(byte);
  return x;
}

/** Why a data template is refused, or undefined if the template list accepts it. */
export function dataTemplateRefusal(t: Template): string | undefined {
  for (const f of t.fields) {
    if (f.enterprise !== undefined) return `enterprise element ${f.enterprise}/${f.id} is not in the record template`;
    if (!DATA_TEMPLATE_FIELDS.has(f.id)) return `element ${f.id} is not in the record template`;
  }
  const ids = new Set(t.fields.map((f) => f.id));
  if (ids.has(IE.octetDeltaCount) && ids.has(IE.postOctetDeltaCount)) return 'ambiguous byte count';
  if (ids.has(IE.packetDeltaCount) && ids.has(IE.postPacketDeltaCount)) return 'ambiguous packet count';
  return undefined;
}

interface Scan {
  header: MessageHeader;
  templates: Template[];
  optionsTemplates: Template[];
  /** Data sets in message order with their offsets. */
  dataSets: Array<{ set: number; id: number; start: number; end: number }>;
}

function scanMessage(b: Buffer, at: number): Scan {
  const header = parseHeader(b, at);
  const end = at + header.length;
  const templates: Template[] = [];
  const optionsTemplates: Template[] = [];
  const dataSets: Scan['dataSets'] = [];
  let o = at + 16;
  let set = 0;
  while (o < end) {
    if (end - o < 4) throw new Error('short set header');
    const id = b.readUInt16BE(o);
    const len = b.readUInt16BE(o + 2);
    if (len < 4 || o + len > end) throw new Error('set length out of range');
    if (id === SET_TEMPLATE) templates.push(...parseTemplateRecords(b, o + 4, o + len, false));
    else if (id === SET_OPTIONS_TEMPLATE) optionsTemplates.push(...parseTemplateRecords(b, o + 4, o + len, true));
    else if (id >= 256) dataSets.push({ set, id, start: o + 4, end: o + len });
    else throw new Error(`reserved set id ${id}`);
    o += len;
    set += 1;
  }
  return { header, templates, optionsTemplates, dataSets };
}

/** Options records of applicable options templates give IE 160 (C11 F57-07). */
function readInitTimes(b: Buffer, scan: Scan, opts: Map<number, Template>, domain: number,
  acc: { times: Set<number>; other: boolean }): void {
  for (const ds of scan.dataSets) {
    const t = opts.get(ds.id);
    if (!t) continue;
    const scopeIds = t.fields.slice(0, t.scopeCount ?? 0).map((f) => f.id);
    const hasInit = t.fields.some((f) => f.id === IE.systemInitTimeMilliseconds);
    if (t.fields.some((f, i) => i >= (t.scopeCount ?? 0) && f.id !== IE.systemInitTimeMilliseconds)) acc.other = true;
    if (!hasInit) continue;
    const applicableScope = scopeIds.includes(IE.observationDomainId) || scopeIds.includes(IE.exportingProcessId);
    if (!applicableScope) continue;
    let o = ds.start;
    const min = minRecordLength(t);
    while (ds.end - o >= min && min > 0) {
      const rec = readRecord(b, o, ds.end, t);
      if (!rec) break;
      o = rec.next;
      const scopeDomain = uint(rec.values.get(IE.observationDomainId));
      if (scopeIds.includes(IE.observationDomainId) && scopeDomain !== BigInt(domain)) continue;
      const init = uint(rec.values.get(IE.systemInitTimeMilliseconds));
      if (init !== undefined) acc.times.add(Number(init));
    }
  }
}

/** Decode one export item (C11 `ExportItem`): the message with the templates of its context. */
export function decodeItem(message: Uint8Array, context: Uint8Array): DecodeResult {
  try {
    const mb = Buffer.from(message.buffer, message.byteOffset, message.byteLength);
    const cb = Buffer.from(context.buffer, context.byteOffset, context.byteLength);
    const msg = scanMessage(mb, 0);
    if (msg.header.length !== mb.length) throw new Error('the item holds more than one message');
    const domain = msg.header.observationDomain;
    const ctxScans: Scan[] = [];
    for (let o = 0; o < cb.length;) {
      const s = scanMessage(cb, o);
      ctxScans.push(s);
      o += s.header.length;
    }
    // The templates of the context, then of the message, in that order.
    const data = new Map<number, Template>();
    const opts = new Map<number, Template>();
    const refusals: TemplateRefusal[] = [];
    const refused = new Set<number>();
    for (const s of [...ctxScans, msg]) {
      for (const t of s.templates) {
        const why = dataTemplateRefusal(t);
        if (why) { refused.add(t.id); data.delete(t.id); refusals.push({ templateId: t.id, observationDomain: s.header.observationDomain, reason: why }); }
        else { refused.delete(t.id); data.set(t.id, t); }
      }
      for (const t of s.optionsTemplates) opts.set(t.id, t);
    }
    const acc = { times: new Set<number>(), other: false };
    for (const s of ctxScans) readInitTimes(cb, s, opts, domain, acc);
    readInitTimes(mb, msg, opts, domain, acc);

    const records: DataRecord[] = [];
    const noTemplateSets: DecodedItem['noTemplateSets'] = [];
    let index = 0;
    for (const ds of msg.dataSets) {
      if (opts.has(ds.id)) continue; // options records are not data records
      const t = data.get(ds.id);
      if (!t || refused.has(ds.id)) { noTemplateSets.push({ set: ds.set, byteOffset: ds.start - 4 }); continue; }
      const min = minRecordLength(t);
      let o = ds.start;
      let record = 0;
      while (min > 0 && ds.end - o >= min) {
        const rec = readRecord(mb, o, ds.end, t);
        if (!rec) throw new Error('truncated data record');
        records.push({ set: ds.set, record, index, byteOffset: o, byteLength: rec.next - o, templateId: t.id, values: rec.values });
        o = rec.next; record += 1; index += 1;
      }
    }
    return { ok: true, item: { header: msg.header, records, templateRefusals: refusals, noTemplateSets,
      initTimesMs: [...acc.times].sort((a, b) => a - b), otherOptionsFields: acc.other } };
  } catch (e) {
    return { ok: false, reason: 'unparseable', detail: (e as Error).message };
  }
}

export interface MeteringFields {
  ifIndex: number;
  direction: 'ingress' | 'egress';
  serviceTag: ServiceTag;
  flowStartMs: number;
  flowEndMs: number;
  bytes: bigint;
  packets?: bigint;
}

/**
 * The record fields of a data record (C11 Part I, F41-09), or the reason to reject it.
 * Relative times (IE 21, 22) are made absolute from the init time of the item's own context.
 */
export function recordFields(rec: DataRecord, initTimeMs: number | undefined):
  { ok: true; fields: MeteringFields } | { ok: false; reason: RejectReason } {
  const v = rec.values;
  let start = uint(v.get(IE.flowStartMilliseconds));
  let end = uint(v.get(IE.flowEndMilliseconds));
  if (start === undefined && v.has(IE.flowStartSysUpTime) && initTimeMs !== undefined) start = BigInt(initTimeMs) + (uint(v.get(IE.flowStartSysUpTime)) ?? 0n);
  if (end === undefined && v.has(IE.flowEndSysUpTime) && initTimeMs !== undefined) end = BigInt(initTimeMs) + (uint(v.get(IE.flowEndSysUpTime)) ?? 0n);
  if (start === undefined || end === undefined) return { ok: false, reason: 'missing flow times' };
  const bytes = uint(v.get(IE.octetDeltaCount)) ?? uint(v.get(IE.postOctetDeltaCount));
  if (bytes === undefined) return { ok: false, reason: 'missing byte count' };
  const dirRaw = uint(v.get(IE.flowDirection));
  const hasIn = v.has(IE.ingressInterface);
  const hasOut = v.has(IE.egressInterface);
  let direction: 'ingress' | 'egress';
  if (dirRaw !== undefined) direction = dirRaw === 0n ? 'ingress' : 'egress';
  else if (hasIn && !hasOut) direction = 'ingress';
  else if (hasOut && !hasIn) direction = 'egress';
  else return { ok: false, reason: 'missing attribution key' };
  const ifRaw = uint(v.get(direction === 'ingress' ? IE.ingressInterface : IE.egressInterface));
  if (ifRaw === undefined) return { ok: false, reason: 'missing attribution key' };
  if (end < start) return { ok: false, reason: 'end time before its start time' };
  const serviceTag: ServiceTag = {};
  const outer = uint(v.get(IE.vlanId)) ?? uint(v.get(IE.dot1qVlanId));
  const inner = uint(v.get(IE.dot1qCustomerVlanId));
  if (outer !== undefined) serviceTag.vlan = inner === undefined ? { outer: Number(outer) } : { outer: Number(outer), inner: Number(inner) };
  const mpls = v.get(IE.mplsTopLabelStackSection);
  if (mpls !== undefined && mpls.length >= 3) serviceTag.mplsLabel = ((mpls[0] ?? 0) << 12) | ((mpls[1] ?? 0) << 4) | ((mpls[2] ?? 0) >> 4);
  const vrfId = uint(v.get(IE.ingressVRFID));
  const vrfName = v.get(IE.VRFname);
  if (vrfId !== undefined) serviceTag.vrf = vrfId.toString();
  else if (vrfName !== undefined) serviceTag.vrf = Buffer.from(vrfName).toString('utf8');
  const packets = uint(v.get(IE.packetDeltaCount)) ?? uint(v.get(IE.postPacketDeltaCount));
  const fields: MeteringFields = { ifIndex: Number(ifRaw), direction, serviceTag, flowStartMs: Number(start), flowEndMs: Number(end), bytes };
  if (packets !== undefined) fields.packets = packets;
  return { ok: true, fields };
}

// ---------------- encoder (for the reference exporter and tests) ----------------

function u16(n: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); return b; }
function u32(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }
function uN(n: bigint, len: number): Buffer {
  const b = Buffer.alloc(len);
  let x = n;
  for (let i = len - 1; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
}

export interface EncodeSet { kind: 'template'; templates: Template[] }
export interface EncodeOptionsSet { kind: 'options'; templates: Template[] }
export interface EncodeDataSet { kind: 'data'; templateId: number; template: Template; records: Array<Map<number, bigint | Uint8Array>> }
export type AnySet = EncodeSet | EncodeOptionsSet | EncodeDataSet;

function encodeTemplateRecord(t: Template, options: boolean): Buffer {
  const parts: Buffer[] = [u16(t.id), u16(t.fields.length)];
  if (options) parts.push(u16(t.scopeCount ?? 0));
  for (const f of t.fields) {
    if (f.enterprise !== undefined) parts.push(u16(f.id | 0x8000), u16(f.length), u32(f.enterprise));
    else parts.push(u16(f.id), u16(f.length));
  }
  return Buffer.concat(parts);
}

function encodeSet(s: AnySet): Buffer {
  let id: number; let body: Buffer;
  if (s.kind === 'template') { id = SET_TEMPLATE; body = Buffer.concat(s.templates.map((t) => encodeTemplateRecord(t, false))); }
  else if (s.kind === 'options') { id = SET_OPTIONS_TEMPLATE; body = Buffer.concat(s.templates.map((t) => encodeTemplateRecord(t, true))); }
  else {
    id = s.templateId;
    const recs: Buffer[] = [];
    for (const r of s.records) {
      for (const f of s.template.fields) {
        const v = r.get(f.id) ?? 0n;
        if (v instanceof Uint8Array) {
          if (f.length === VARIABLE) recs.push(Buffer.from([v.length]), Buffer.from(v));
          else recs.push(Buffer.from(v).subarray(0, f.length));
        } else recs.push(uN(v, f.length));
      }
    }
    body = Buffer.concat(recs);
  }
  return Buffer.concat([u16(id), u16(body.length + 4), body]);
}

/** One IPFIX message. */
export function encodeMessage(h: { exportTimeS: number; sequence: number; observationDomain: number }, sets: AnySet[]): Uint8Array {
  const body = Buffer.concat(sets.map(encodeSet));
  return new Uint8Array(Buffer.concat([u16(IPFIX_VERSION), u16(body.length + 16), u32(h.exportTimeS), u32(h.sequence),
    u32(h.observationDomain), body]));
}

/** The template of the Share metering template that the reference exporter uses (absolute times, egress). */
export const METERING_TEMPLATE: Template = {
  id: 256,
  fields: [
    { id: IE.flowStartMilliseconds, length: 8 }, { id: IE.flowEndMilliseconds, length: 8 },
    { id: IE.octetDeltaCount, length: 8 }, { id: IE.packetDeltaCount, length: 8 },
    { id: IE.egressInterface, length: 4 }, { id: IE.flowDirection, length: 1 }, { id: IE.vlanId, length: 2 },
  ],
};

/** The minimal options template that a relay can send: scope 149 and IE 160 (C11 F57-07). */
export const INIT_TIME_OPTIONS: Template = {
  id: 257, scopeCount: 1,
  fields: [{ id: IE.observationDomainId, length: 4 }, { id: IE.systemInitTimeMilliseconds, length: 8 }],
};

/** A context: the templates and options in force at first export, as one IPFIX message. */
export function encodeContext(h: { exportTimeS: number; observationDomain: number; initTimeMs: number },
  template: Template = METERING_TEMPLATE): Uint8Array {
  return encodeMessage({ exportTimeS: h.exportTimeS, sequence: 0, observationDomain: h.observationDomain }, [
    { kind: 'template', templates: [template] },
    { kind: 'options', templates: [INIT_TIME_OPTIONS] },
    { kind: 'data', templateId: INIT_TIME_OPTIONS.id, template: INIT_TIME_OPTIONS,
      records: [new Map<number, bigint>([[IE.observationDomainId, BigInt(h.observationDomain)], [IE.systemInitTimeMilliseconds, BigInt(h.initTimeMs)]])] },
  ]);
}
