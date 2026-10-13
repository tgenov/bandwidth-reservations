/**
 * The gRPC transport of placement's integrity stop (C01 §2.6; plan S-PLAT-I3 work item 9). Audit calls it; the
 * server gives each call to an `IntegrityStopService` with the caller's mTLS workload identity.
 *
 * The wire format is protobuf (proto3), encoded here by hand:
 *
 *   package share.placement.v1;
 *   service IntegrityStop { rpc Stop(StopRequest) returns (StopAck); rpc Resume(ResumeRequest) returns (StopAck); }
 *   message StopRequest   { string kind = 1; bytes partition = 2; bytes detection_ref = 3; }
 *   message ResumeRequest { string kind = 1; bytes partition = 2; bytes detection_ref = 3; bytes checkpoint = 4;
 *                           bytes incident_decision_ref = 5; }
 *   message StopAck { enum State { STOPPED = 0; RESUMED = 1; } State state = 1; string enforced_at = 2;
 *                     repeated int32 fenced_slots = 3; }
 *
 * A refusal goes back as a gRPC status with the C01 code in the details and in the trailer `x-share-error`.
 * An empty `incident_decision_ref` means "not given" (proto3 has no presence for bytes).
 */
import grpc from '@grpc/grpc-js';
import type { ChannelCredentials, ServerCredentials, ServerUnaryCall, sendUnaryData } from '@grpc/grpc-js';
import {
  INTEGRITY_STOP_ERROR_CODES, IntegrityStopError, type IntegrityStopCaller, type IntegrityStopErrorCode, type ResumeRequest,
  type StopAck, type StopRequest,
} from './integrity-stop.ts';
import {
  INTEGRITY_STOP_CODEC_ERROR_CODES, IntegrityStopCodecError, decodeResumeRequest, decodeStopAck, decodeStopRequest, encodeResumeRequest,
  encodeStopAck, encodeStopRequest,
} from './integrity-stop-codec.ts';

/** The gRPC method path of `Stop`. */
export const INTEGRITY_STOP_PATH = '/share.placement.v1.IntegrityStop/Stop';
/** The gRPC method path of `Resume`. */
export const INTEGRITY_RESUME_PATH = '/share.placement.v1.IntegrityStop/Resume';
/** The trailer that carries the C01 error code (or the codec error code). */
export const SHARE_ERROR_HEADER = 'x-share-error';
/** The test-only request header that names the caller's workload (`insecureWorkloadHeader`). */
export const WORKLOAD_HEADER = 'x-workload';

const toBuf = (b: Uint8Array): Buffer => Buffer.from(b.buffer, b.byteOffset, b.byteLength);
const identity = (b: Buffer): Buffer => b;

// ---------------- server ----------------

/** The part of `IntegrityStopService` that the server calls. */
export interface IntegrityStopHandler {
  stop(caller: IntegrityStopCaller, req: StopRequest): Promise<StopAck>;
  resume(caller: IntegrityStopCaller, req: ResumeRequest): Promise<StopAck>;
}

/** Options of a `GrpcIntegrityStopServer`. */
export interface GrpcIntegrityStopServerOptions {
  service: IntegrityStopHandler;
  /** Server credentials. Default: insecure (in-process tests). Production uses mTLS (RFC-005). */
  credentials?: ServerCredentials;
  /** The caller's mTLS workload identity, or undefined when it has none (then PERMISSION_DENIED). */
  workloadOf?: (call: ServerUnaryCall<Buffer, Buffer>) => string | undefined;
  /** Tests only: without `workloadOf`, read the workload from the request header `x-workload`. */
  insecureWorkloadHeader?: boolean;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

const STATUS_OF: Record<IntegrityStopErrorCode, grpc.status> = {
  PERMISSION_DENIED: grpc.status.PERMISSION_DENIED,
  NOT_STOPPED: grpc.status.FAILED_PRECONDITION,
  HEAD_MISMATCH: grpc.status.FAILED_PRECONDITION,
  CONFLICT: grpc.status.ALREADY_EXISTS,
};

function refusal(status: grpc.status, code: string, details: string): Partial<grpc.StatusObject> {
  const metadata = new grpc.Metadata();
  metadata.set(SHARE_ERROR_HEADER, code);
  return { code: status, details, metadata };
}

/** Placement's gRPC endpoint of `share.placement.v1.IntegrityStop`. */
export class GrpcIntegrityStopServer {
  private readonly server = new grpc.Server();
  private readonly o: GrpcIntegrityStopServerOptions;
  private readonly credentials: ServerCredentials;
  private readonly log: (msg: string, fields?: Record<string, unknown>) => void;

  constructor(o: GrpcIntegrityStopServerOptions) {
    this.o = o;
    this.credentials = o.credentials ?? grpc.ServerCredentials.createInsecure();
    this.log = o.log ?? (() => {});
    const method = (path: string) => ({
      path, requestStream: false, responseStream: false,
      requestSerialize: identity, requestDeserialize: identity, responseSerialize: identity, responseDeserialize: identity,
    });
    this.server.addService({ stop: method(INTEGRITY_STOP_PATH), resume: method(INTEGRITY_RESUME_PATH) }, {
      stop: (call: ServerUnaryCall<Buffer, Buffer>, done: sendUnaryData<Buffer>) =>
        this.handle(call, done, (caller, b) => this.o.service.stop(caller, decodeStopRequest(b))),
      resume: (call: ServerUnaryCall<Buffer, Buffer>, done: sendUnaryData<Buffer>) =>
        this.handle(call, done, (caller, b) => this.o.service.resume(caller, decodeResumeRequest(b))),
    });
  }

  /** Binds `address` (`host:port`, port 0 for any) and returns the bound port. */
  listen(address: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.bindAsync(address, this.credentials, (err, port) => { if (err) reject(err); else resolve(port); });
    });
  }

  /** Stops the server at once and cancels every open call. */
  async close(): Promise<void> {
    this.server.forceShutdown();
  }

  private workload(call: ServerUnaryCall<Buffer, Buffer>): string | undefined {
    if (this.o.workloadOf) return this.o.workloadOf(call);
    if (this.o.insecureWorkloadHeader !== true) return undefined;
    const v = call.metadata.get(WORKLOAD_HEADER)[0];
    return typeof v === 'string' ? v : undefined;
  }

  private handle(call: ServerUnaryCall<Buffer, Buffer>, done: sendUnaryData<Buffer>,
    run: (caller: IntegrityStopCaller, b: Buffer) => Promise<StopAck>): void {
    const workload = this.workload(call);
    if (workload === undefined) {
      done(refusal(grpc.status.PERMISSION_DENIED, 'PERMISSION_DENIED', 'PERMISSION_DENIED: the caller has no workload identity'), null);
      return;
    }
    // A decoder refusal throws at once; the promise chain turns it into a rejection with its code.
    Promise.resolve().then(() => run({ workload }, call.request)).then(
      (ack) => done(null, toBuf(encodeStopAck(ack))),
      (e: unknown) => {
        if (e instanceof IntegrityStopError) { done(refusal(STATUS_OF[e.code], e.code, e.message), null); return; }
        if (e instanceof IntegrityStopCodecError) { done(refusal(grpc.status.INVALID_ARGUMENT, e.code, e.message), null); return; }
        // Not known to be committed: the caller sends the same detection_ref again (C01 §5).
        this.log('integrity stop call failed', { error: String(e) });
        done({ code: grpc.status.UNAVAILABLE, details: String(e) }, null);
      },
    );
  }
}

// ---------------- client ----------------

/** Options of a `GrpcIntegrityStopClient`. */
export interface GrpcIntegrityStopClientOptions {
  /** `host:port` of placement. */
  address: string;
  /** Channel credentials. Default: insecure (in-process tests). Production uses mTLS (RFC-005). */
  credentials?: ChannelCredentials;
  /** Tests only: the workload sent in the header `x-workload` (the server reads it with `insecureWorkloadHeader`). */
  workload?: string;
  /** Deadline of one call. Default 5 000 ms (est.). */
  deadlineMs?: number;
  /** The clock of the deadline. Default `Date.now`. */
  now?: () => number;
}

/** Audit's client of `share.placement.v1.IntegrityStop`. A refusal is thrown as `IntegrityStopError`. */
export class GrpcIntegrityStopClient {
  private readonly client: grpc.Client;
  private readonly o: GrpcIntegrityStopClientOptions;

  constructor(o: GrpcIntegrityStopClientOptions) {
    this.o = o;
    this.client = new grpc.Client(o.address, o.credentials ?? grpc.credentials.createInsecure());
  }

  /** `Stop`. Throws `IntegrityStopError`, `IntegrityStopCodecError` (a codec refusal) or a gRPC error. */
  stop(req: StopRequest): Promise<StopAck> {
    return this.call(INTEGRITY_STOP_PATH, encodeStopRequest(req));
  }

  /** `Resume`. Throws `IntegrityStopError`, `IntegrityStopCodecError` (a codec refusal) or a gRPC error. */
  resume(req: ResumeRequest): Promise<StopAck> {
    return this.call(INTEGRITY_RESUME_PATH, encodeResumeRequest(req));
  }

  /** Closes the connection. */
  async close(): Promise<void> {
    this.client.close();
  }

  private call(path: string, body: Uint8Array): Promise<StopAck> {
    const md = new grpc.Metadata();
    if (this.o.workload !== undefined) md.set(WORKLOAD_HEADER, this.o.workload);
    const deadline = (this.o.now ?? Date.now)() + (this.o.deadlineMs ?? 5_000);
    return new Promise((resolve, reject) => {
      this.client.makeUnaryRequest<Buffer, Buffer>(path, identity, identity, toBuf(body), md, { deadline }, (err, value) => {
        if (err) { reject(fromStatus(err)); return; }
        try { resolve(decodeStopAck(value ?? Buffer.alloc(0))); } catch (e) { reject(e); }
      });
    });
  }
}

/** Maps a gRPC status with an `x-share-error` trailer back to the refusal; any other status stays a gRPC error. */
function fromStatus(err: grpc.ServiceError): Error {
  const v = err.metadata?.get(SHARE_ERROR_HEADER)[0];
  const code = typeof v === 'string' ? v : undefined;
  const details = code !== undefined && err.details.startsWith(`${code}: `) ? err.details.slice(code.length + 2) : err.details;
  const sharedCode = INTEGRITY_STOP_ERROR_CODES.find((c) => c === code);
  if (sharedCode) return new IntegrityStopError(sharedCode, details);
  const codecCode = INTEGRITY_STOP_CODEC_ERROR_CODES.find((c) => c === code);
  if (codecCode) return new IntegrityStopCodecError(codecCode, details);
  return err;
}
