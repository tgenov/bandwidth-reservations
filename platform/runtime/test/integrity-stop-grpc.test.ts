/**
 * S-PLAT-I3 work item 9: the gRPC transport of placement's integrity stop (C01 §2.6). Server and client run in this
 * process on loopback (127.0.0.1); the service runs on the memory store.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import grpc from '@grpc/grpc-js';
import { hex, utf8 } from '../src/bytes.ts';
import { slotOfPartition } from '../src/home.ts';
import { hlc } from '../src/hlc.ts';
import { MemoryStore } from '../src/store/memory.ts';
import {
  IntegrityStopError, IntegrityStopService, MemoryIntegrityStopStore, placementSlotLocator, type HeadInspector, type ResumeRequest,
  type StopRequest,
} from '../src/placement/integrity-stop.ts';
import {
  GrpcIntegrityStopClient, GrpcIntegrityStopServer, INTEGRITY_STOP_PATH, SHARE_ERROR_HEADER, type GrpcIntegrityStopServerOptions,
} from '../src/placement/integrity-stop-grpc.ts';
import { IntegrityStopCodecError, encodeResumeRequest, encodeStopRequest } from '../src/placement/integrity-stop-codec.ts';
import { Closers, steppedClock } from './support.ts';

const T = { timeout: 15_000 };
const closers = new Closers();
afterEach(() => closers.closeAll());

const KIND = 'hlink';
const P = utf8('link-7');
const REF = utf8('det-1');
const START = 1_800_000_000_000;
const TS0 = hlc(`${BigInt(START) * 1_000_000n}.0000000000`);
const stopReq: StopRequest = { kind: KIND, partition: P, detectionRef: REF };
const resumeReq = (over: Partial<ResumeRequest> = {}): ResumeRequest => ({ kind: KIND, partition: P, detectionRef: REF, checkpoint: utf8('cp'), ...over });

/** A head inspector double: the first-seen head and the head now differ. */
const mismatched: HeadInspector = { headChainAt: async (_k, _p, at) => utf8(at === 'present' ? 'restored' : 'first-seen') };

async function boot(o: Partial<GrpcIntegrityStopServerOptions> = { insecureWorkloadHeader: true }) {
  const clock = steppedClock(START);
  const store = new MemoryStore({ wallMs: clock.now });
  store.seedSlots(KIND, 4);
  const stops = new MemoryIntegrityStopStore(store);
  const service = new IntegrityStopService({ store: stops, locator: placementSlotLocator({ slotCounts: { [KIND]: 4 } }), heads: mismatched });
  const server = new GrpcIntegrityStopServer({ service, ...o });
  const port = await server.listen('127.0.0.1:0');
  closers.add(() => server.close());
  /** `null`: the client sends no x-workload header. */
  const client = (workload: string | null = 'audit'): GrpcIntegrityStopClient => {
    const c = new GrpcIntegrityStopClient({ address: `127.0.0.1:${port}`, ...(workload === null ? {} : { workload }) });
    closers.add(() => c.close());
    return c;
  };
  return { store, stops, port, client };
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) {
    if (e instanceof IntegrityStopError || e instanceof IntegrityStopCodecError) return `${e.name}:${e.code}`;
    throw e;
  }
  return 'NO_ERROR';
}

/** Sends raw bytes to a method and gives the gRPC status code and the `x-share-error` trailer. */
function raw(port: number, path: string, body: Uint8Array, workload = 'audit'): Promise<{ code: number; shareError: unknown }> {
  const c = new grpc.Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
  closers.add(async () => c.close());
  const md = new grpc.Metadata();
  md.set('x-workload', workload);
  const id = (b: Buffer): Buffer => b;
  return new Promise((resolve) => {
    c.makeUnaryRequest<Buffer, Buffer>(path, id, id, Buffer.from(body), md, (err) => {
      resolve({ code: err?.code ?? grpc.status.OK, shareError: err?.metadata.get(SHARE_ERROR_HEADER)[0] });
    });
  });
}

// ---------------- over the wire ----------------

test('C01 CP-6 a Stop over gRPC returns the StopAck after the fence commit and bumps the holding slot', T, async () => {
  const { client, store } = await boot();
  const slot = slotOfPartition(P, 4);
  const ack = await client().stop(stopReq);
  assert.deepEqual(ack, { state: 'STOPPED', enforcedAt: TS0, fencedSlots: [slot] });
  assert.equal(store.slotRow(KIND, slot)?.stopsVersion, 1n);
  assert.deepEqual(store.stops.get(`${KIND}|${hex(P)}`), REF);
});

test('C01 CP-6 a failed fence commit over gRPC gives UNAVAILABLE and no ack and no stop', T, async () => {
  const { client, store, stops } = await boot();
  stops.failNextCommit = true;
  await assert.rejects(client().stop(stopReq), (e: unknown) => (e as grpc.ServiceError).code === grpc.status.UNAVAILABLE && !(e instanceof IntegrityStopError));
  assert.equal(store.stops.size, 0);
  assert.equal(store.slotRow(KIND, slotOfPartition(P, 4))?.stopsVersion, 0n);
});

test('should map each refusal code to its gRPC status and give it back to the client when a call is refused', T, async () => {
  const { client, port, store } = await boot();
  assert.equal(await refusal(client('rating').stop(stopReq)), 'IntegrityStopError:PERMISSION_DENIED');
  assert.deepEqual(await raw(port, INTEGRITY_STOP_PATH, encodeStopRequest(stopReq), 'rating'), { code: grpc.status.PERMISSION_DENIED, shareError: 'PERMISSION_DENIED' });
  assert.equal(store.stops.size, 0);
  const audit = client();
  assert.equal(await refusal(audit.resume(resumeReq())), 'IntegrityStopError:NOT_STOPPED');
  await audit.stop(stopReq);
  assert.equal(await refusal(audit.stop({ ...stopReq, partition: utf8('other') })), 'IntegrityStopError:CONFLICT');
  assert.equal(await refusal(audit.resume(resumeReq())), 'IntegrityStopError:HEAD_MISMATCH');
  assert.equal((await audit.resume(resumeReq({ incidentDecisionRef: utf8('inc') }))).state, 'RESUMED');
});

test('should send NOT_STOPPED and HEAD_MISMATCH as FAILED_PRECONDITION and CONFLICT as ALREADY_EXISTS when the raw status is read', T, async () => {
  const { client, port } = await boot();
  const path = '/share.placement.v1.IntegrityStop/Resume';
  assert.deepEqual(await raw(port, path, encodeResumeRequest(resumeReq())), { code: grpc.status.FAILED_PRECONDITION, shareError: 'NOT_STOPPED' });
  await client().stop(stopReq);
  assert.deepEqual(await raw(port, path, encodeResumeRequest(resumeReq())), { code: grpc.status.FAILED_PRECONDITION, shareError: 'HEAD_MISMATCH' });
  assert.deepEqual(await raw(port, INTEGRITY_STOP_PATH, encodeStopRequest({ ...stopReq, kind: 'other' })), { code: grpc.status.ALREADY_EXISTS, shareError: 'CONFLICT' });
});

test('should refuse with INVALID_ARGUMENT and the codec code when a request does not decode', T, async () => {
  const { port, store } = await boot();
  assert.deepEqual(await raw(port, INTEGRITY_STOP_PATH, new Uint8Array([0x0a, 5, 0x6b])), { code: grpc.status.INVALID_ARGUMENT, shareError: 'TRUNCATED' });
  assert.deepEqual(await raw(port, INTEGRITY_STOP_PATH, encodeStopRequest({ ...stopReq, detectionRef: new Uint8Array() })),
    { code: grpc.status.INVALID_ARGUMENT, shareError: 'MISSING_FIELD' });
  assert.equal(store.stops.size, 0);
});

test('should give the client an IntegrityStopCodecError when the server refuses the request as a codec error', T, async () => {
  const { client } = await boot();
  assert.equal(await refusal(client().stop({ ...stopReq, kind: '' })), 'IntegrityStopCodecError:MISSING_FIELD');
});

test('should refuse with PERMISSION_DENIED when the x-workload header is sent but the insecure header option is off', T, async () => {
  const { client, store } = await boot({});
  assert.equal(await refusal(client('audit').stop(stopReq)), 'IntegrityStopError:PERMISSION_DENIED');
  assert.equal(store.stops.size, 0);
});

test('should use the workloadOf callback when it is given', T, async () => {
  const seen: string[] = [];
  const { client } = await boot({ workloadOf: (call) => { seen.push(call.getPath()); return 'audit'; } });
  assert.equal((await client(null).stop(stopReq)).state, 'STOPPED');
  assert.deepEqual(seen, [INTEGRITY_STOP_PATH]);
});

test('should refuse with PERMISSION_DENIED when no workload header is sent', T, async () => {
  const { client } = await boot();
  assert.equal(await refusal(client(null).stop(stopReq)), 'IntegrityStopError:PERMISSION_DENIED');
});

test('should give the same StopAck when the same Stop is sent twice over gRPC', T, async () => {
  const { client, store } = await boot();
  const c = client();
  const a = await c.stop(stopReq);
  const b = await c.stop(stopReq);
  assert.deepEqual(b, a);
  assert.equal(store.slotRow(KIND, slotOfPartition(P, 4))?.stopsVersion, 1n);
});
