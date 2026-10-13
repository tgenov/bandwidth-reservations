/**
 * @share/ingestion/testing: the reference exporter simulator (C11 tests 14 and 15, I1 subset).
 *
 * The exporter keeps every message with the context in force when it first exported it. It
 * resends both byte-identical until a batch is acknowledged, and never resends an
 * acknowledged batch. It uses only elements of the record template, with `flowDirection`.
 */
import type { Batch, BatchAck, EdgeFrame, ExportItem } from '@share/rate-common';
import { IE, METERING_TEMPLATE, encodeContext, encodeMessage } from '../src/ipfix.ts';
import type { EdgePrincipal, IngestSession } from '../src/ingest-owner.ts';

export interface FlowSpec {
  startMs: number;
  endMs: number;
  bytes: bigint;
  packets?: bigint;
  ifIndex: number;
  vlan?: number;
}

export function exporterPrincipal(args: { supplier?: string; certSerial?: string; region?: 'R1' | 'R2'; kind?: string }): EdgePrincipal {
  return {
    schema: 'principal.v1', principal_id: `exp-${args.certSerial ?? 'c1'}`, kind: args.kind ?? 'exporter',
    tenant: args.supplier ? { kind: 'supplier', supplier: args.supplier } : { kind: 'none' },
    cert_serial: args.certSerial ?? 'c1', probe: false, edge_region: args.region ?? 'R1',
  };
}

export class ReferenceExporter {
  private sequence = 0;
  private batchNo = 0;
  readonly unacked = new Map<string, Batch>();
  readonly acks: BatchAck[] = [];
  readonly notices: EdgeFrame[] = [];

  readonly domain: number;
  readonly initTimeMs: number;
  /** The templates and options in force since the exporter started; the same bytes for each item. */
  readonly context: Uint8Array;

  constructor(domain: number, initTimeMs: number) {
    this.domain = domain;
    this.initTimeMs = initTimeMs;
    this.context = encodeContext({ exportTimeS: Math.floor(initTimeMs / 1000), observationDomain: domain, initTimeMs });
  }

  /** One export item: an IPFIX message of the given flows, with its first-export context. */
  exportItem(flows: FlowSpec[], exportTimeS: number): ExportItem {
    const records = flows.map((f) => new Map<number, bigint>([
      [IE.flowStartMilliseconds, BigInt(f.startMs)], [IE.flowEndMilliseconds, BigInt(f.endMs)],
      [IE.octetDeltaCount, f.bytes], [IE.packetDeltaCount, f.packets ?? 1n],
      [IE.egressInterface, BigInt(f.ifIndex)], [IE.flowDirection, 1n], [IE.vlanId, BigInt(f.vlan ?? 0)],
    ]));
    const message = encodeMessage({ exportTimeS, sequence: this.sequence, observationDomain: this.domain }, [
      { kind: 'data', templateId: METERING_TEMPLATE.id, template: METERING_TEMPLATE, records },
    ]);
    // IPFIX: the sequence counts the data records sent before this message (RFC 7011 §3.1).
    this.sequence = (this.sequence + flows.length) >>> 0;
    return { message, context: this.context };
  }

  /** A new batch of items. It stays in `unacked` until an acknowledgement names it. */
  batch(items: ExportItem[]): Batch {
    this.batchNo += 1;
    const b: Batch = { batchNo: String(this.batchNo), items: items.map((it) => ({ exportMessage: it })) };
    this.unacked.set(b.batchNo, b);
    return b;
  }

  /** Send a batch on a session and keep the answer. */
  async send(session: IngestSession, b: Batch): Promise<EdgeFrame[]> {
    const frames = await session.onBatch(b);
    for (const f of frames) {
      if ('ack' in f) { this.acks.push(f.ack); this.unacked.delete(f.ack.batchNo); } else this.notices.push(f);
    }
    return frames;
  }

  /** Resend every unacknowledged batch, byte-identical (after ingest_retry_timeout), on any session. */
  async resendUnacked(session: IngestSession): Promise<void> {
    for (const b of [...this.unacked.values()]) await this.send(session, b);
  }
}
