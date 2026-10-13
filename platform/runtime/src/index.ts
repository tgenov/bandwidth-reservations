/** @share/owner-runtime — C01 v1 owner runtime (S-PLAT I1a, I1b). */
export * from './api.ts';
export { systemClock, type WallClock } from './clock.ts';
export { hlc, compareHlc, hlcFromWallMs, hlcToWallMs, hlcAddMs, hlcParts, hlcBefore } from './hlc.ts';
export { home, homeKey, reverseBits20, slotOfPartition, isPowerOfTwo } from './home.ts';
export { chainGenesis, chainNext, type ChainRow } from './chain.ts';
export { DevSealer, type Sealer, type SealContext } from './sealer.ts';
export { validateDeclaration, validTopic, assertDeclaration, assertIdentifier, projectionKeyColumns, tableNames } from './declaration.ts';
export { rowId } from './rowref.ts';
export { OVERLOAD, PARAMS } from './params.ts';
export { LaneCostModel, SlotAdmission, expectedSojournMs, type AdmissionState, type Random } from './overload.ts';
export { hex, fromHex, utf8, bytesEqual, encodeJson, decodeJson } from './bytes.ts';
export {
  CockroachOwnerRuntime, NotInThisIncrement, SlotGroupError, type SlotGroupErrorCode, type OwnerRuntimeOptions, type MoveOptions, type MoveInbox,
  type ReportFence, type IntegrityReport, type AckSplittingRequest, type ListPartitionsAnswer, type OverloadStats,
} from './runtime.ts';
export { PLATFORM_ENTRY, isPlatformEntry, type PlatformOp, type IntegrityHold } from './batch/attempt.ts';
export { PgStore, C02_DISPLACEMENT, pgFeedSeqReader, type PgStoreOptions, type DisplacementBinding } from './store/pg.ts';
export type { OwnerStore, StoredHead, BatchWrites } from './store/types.ts';
export { KafkaPublisher, MemoryPublisher, type Publisher, type KafkaPublisherOptions } from './publisher.ts';
export type { OutboxMessage } from './batch/attempt.ts';
export { EventLoopMonitor, ManualLoad, type LoadMonitor } from './load.ts';

// ---------- I1b: feeds, relay, closure, consumer runtime, reporting, status readers, placement feed, ACLs ----------
export { partitionForKey, targetPartition, type FeedBus, type BusRecord, type BusProduceRecord, type BusSubscription, type BusSubscribeOptions } from './feed/bus.ts';
export { waitForTopicLeaders, type TopicMetadataFetch } from './feed/topic-leaders.ts';
export { MemoryBus } from './feed/memory-bus.ts';
export { KafkaBus, type KafkaBusOptions } from './feed/kafka-bus.ts';
export {
  feedEventDigest, recordToFeedEvent, outboxHeadersToKafka, outboxHeadersToFeed, isMarkerEvent, markerSealContext, encodeMarker,
  decodeMarker, markerKey, encodeClosure, decodeClosure, encodeRelayProgress, decodeRelayProgress, closureTopic, cdcTopic,
  relayProgressTopic, topicKind, type ClosureMessage,
} from './feed/wire.ts';
export {
  OutboxRelay, parseCdcMessage, parseCdcLogMessage, type RelayDerivation, type CdcLogMessage, changefeedStatement, ensureChangefeed, cancelChangefeeds, changefeedJobs,
  type RelayOptions, type ChangefeedOptions, type CdcMessage, type CdcOutboxRow,
} from './relay/relay.ts';
export { ClosureEmitter, emitterSlotKind, type ClosureEmitterOptions, type FeedSeqReader } from './closure/emitter.ts';
export { FeedConsumerRuntime, type FeedConsumerOptions, type ConsumerAlert } from './consumer/consumer.ts';
export {
  PgGapFill, MemoryGapFill, LogDerivedGapFill, pgStreamIndex, type GapFillSource, type GapFillRow, type PgGapFillOptions, type StreamIndexReader,
} from './consumer/gapfill.ts';
export { REPORT, SlotReport, markerChunks, outcomeStream, reportsMarkers, type LeaseAnswer, type ReaderChannel, type ReadLease } from './report/report.ts';
export { StatusReader, ceilMicrosLiteral, type StatusReaderOptions, type ReadLeaseHolder } from './status/reader.ts';
export { SlotMapCache, SLOT_MAP_TOPIC, fixedSlotMap, publishSlotMap, slotOfInMap, encodeSlotMap, decodeSlotMap, type SlotMapCacheOptions } from './placement/slot-map.ts';
export { producerAcls, aclCommands, kafkajsAcls, checkAcls, holderPrincipal, relayPrincipal, closureEmitterPrincipal, type TopicAcl, type ExtraProducers, type AclOptions } from './acl/kafka-acl.ts';

// ---------- I2: self-outboxed kinds, checkpoints ----------
export {
  deriveEvents, eventRecord, openLogRow, emitFunction, emitFunctionErrors, checkDeclaredEvents, SelfOutboxedError,
  type SelfOutboxedErrorCode, type EmitFunctions, type EmitFunction, type EmitInput, type EventRecord, type EventPlace,
} from './selfout/derive.ts';
export {
  CheckpointStore, CheckpointError, MemoryObjectStore, FileObjectStore, CHECKPOINT,
  type ObjectStore, type CheckpointErrorCode, type CheckpointAlert, type CheckpointStoreOptions,
} from './checkpoint/store.ts';
export { S3ObjectStore, S3ObjectStoreError, type S3Api, type S3ObjectStoreOptions, type S3ObjectStoreErrorCode } from './checkpoint/s3.ts';

export {
  TIMING, tauFor, writeTimingVersion, readTimingVersion, TimingVersionRefused, TimingAlarms, TimingProbe, toOperationalAlert,
  type TimingVersion, type SecondLaneSettings, type TimingAlarmId, type TimingAlert, type TimingRoundTripPort,
  type OffsetLevel as TimingOffsetLevel,
} from './placement/timing.ts';
export { TimingController, busAlertSink, type TimingControllerOptions } from './placement/timing-controller.ts';
export { OffsetMonitor, OFFSET, type OffsetLevel, type OffsetSample, type OffsetMonitorOptions } from './offset.ts';
export { GatewayTiers, TierTimeout, withTierTimeout, type GatewayTiersOptions } from './store/tiers.ts';
export { StandbyTail, STANDBY_BUFFER_MAX, type StandbyPush, type StandbyChannel, type StandbyStats, type TailRow } from './standby/tail.ts';
export {
  GrpcStandbyChannel, GrpcStandbyServer, StandbyCodecError, encodeStandbyPush, decodeStandbyPush, STANDBY_PUSH_PATH,
  STANDBY_PUSH_QUEUE_MAX, type GrpcStandbyChannelOptions, type GrpcStandbyChannelStats, type GrpcStandbyServerOptions,
  type StandbyCodecErrorCode,
} from './standby/grpc.ts';

// ---------- I3: moves, integrity stops, slot map service ----------
export {
  IntegrityStopService, IntegrityStopError, FenceSlotMissingError, INTEGRITY_STOP_ERROR_CODES, MemoryIntegrityStopStore, placementSlotLocator,
  type IntegrityStopErrorCode, type StopRequest, type ResumeRequest, type StopAck, type IntegrityStopCaller, type IntegrityStopRow,
  type PartitionMoveRow, type MoveLookup, type IntegrityStopTx, type IntegrityStopStore, type SlotLocator, type HeadInspector,
  type PlacementSlotLocatorOptions, type IntegrityStopServiceOptions,
} from './placement/integrity-stop.ts';
export {
  encodeStopRequest, decodeStopRequest, encodeResumeRequest, decodeResumeRequest, encodeStopAck, decodeStopAck, IntegrityStopCodecError,
  INTEGRITY_STOP_CODEC_ERROR_CODES, type IntegrityStopCodecErrorCode,
} from './placement/integrity-stop-codec.ts';
export {
  GrpcIntegrityStopServer, GrpcIntegrityStopClient, INTEGRITY_STOP_PATH, INTEGRITY_RESUME_PATH, SHARE_ERROR_HEADER, WORKLOAD_HEADER,
  type IntegrityStopHandler, type GrpcIntegrityStopServerOptions, type GrpcIntegrityStopClientOptions,
} from './placement/integrity-stop-grpc.ts';
export {
  SlotMapService, MemorySlotMapStore, SlotMapError, accountTopicPartitions, SPLIT_PARALLELISM, type SlotMapErrorCode, type SlotMapStore,
  type SlotMapServiceOptions, type HolderPartitionLister, type ProbeAccountRow, type SplitAckRow, type RequestRow, type DoublingState,
  type DoublingPhase, type SlotProgress, type ReslotRequest, type ReslotRefusal, type ReslotAnswer, type DoublingStep,
} from './placement/slot-map-service.ts';
export {
  DevSummarySigner, verifyProbeSetSummary, probeSetDigest, probeSetSummaryBytes, signProbeSetSummary, sortProbeSet,
  type ProbeSetSummary, type ProbeMember, type SummarySigner,
} from './placement/probe-set.ts';
export { PgSlotMapStore, SLOT_MAP_EXTRA_TABLES, type SlotMapPgPool, type SlotMapPgClient } from './placement/pg-slot-map-store.ts';
export {
  MoveCoordinator, MemoryMoveStore, MoveError, HotPartitionDetector, MOVE_CUTOVER_MAX_MS, HOT_RATE_PER_S, HOT_WINDOW_MS,
  type MoveRequest, type MoveHolders, type MoveStore, type MoveErrorCode, type MoveCutoverAlert, type Scheduler, type MoveCoordinatorOptions,
} from './placement/moves.ts';
export { staleSenderAction, type StaleSenderAction } from './fencing.ts';
export { PgIntegrityStopStore, type PgClientLike, type PgPoolLike, type PgIntegrityStopStoreOptions } from './placement/pg-integrity-stop.ts';

// TODO(S-PLAT-I1 item 15, C01 §3.1–§3.6): TLA+ model of sessions, revocation, resume, re-home, epochs, slot batches,
//   handoff, read leases, report position, marker chain, relay progress and closure; TLC in CI.
// TODO(S-PLAT-I1 item 16, C01 §3.1, §3.2, §3.5): Jepsen-style harness on the dev cell (partitions, pauses past
//   session_ttl, delayed renewals, Ambiguous commits, crashes in acquisition/handoff/re-home/resume, a holder killed
//   between commit and publish while one relay lags); 24 h with no violation.
