/** @share/owner-runtime — C01 v1 owner runtime (S-PLAT I1a, I1b). */
export * from './api.ts';
export { hlc, compareHlc, hlcFromWallMs, hlcToWallMs, hlcAddMs, hlcParts } from './hlc.ts';
export { home, homeKey, reverseBits20, slotOfPartition, isPowerOfTwo } from './home.ts';
export { chainGenesis, chainNext, type ChainRow } from './chain.ts';
export { DevSealer, type Sealer, type SealContext } from './sealer.ts';
export { validateDeclaration, validTopic, assertDeclaration, assertIdentifier, projectionKeyColumns, tableNames } from './declaration.ts';
export { rowId } from './rowref.ts';
export { PARAMS } from './params.ts';
export { hex, fromHex, utf8, bytesEqual, encodeJson, decodeJson } from './bytes.ts';
export { CockroachOwnerRuntime, NotInThisIncrement, type OwnerRuntimeOptions } from './runtime.ts';
export { PgStore, C02_DISPLACEMENT, pgFeedSeqReader, type PgStoreOptions, type DisplacementBinding } from './store/pg.ts';
export type { OwnerStore, StoredHead, BatchWrites } from './store/types.ts';
export { KafkaPublisher, MemoryPublisher, type Publisher, type KafkaPublisherOptions } from './publisher.ts';
export type { OutboxMessage } from './batch/attempt.ts';
export { EventLoopMonitor, ManualLoad, type LoadMonitor } from './load.ts';

// ---------- I1b: feeds, relay, closure, consumer runtime, reporting, status readers, placement feed, ACLs ----------
export { partitionForKey, type FeedBus, type BusRecord, type BusProduceRecord, type BusSubscription, type BusSubscribeOptions } from './feed/bus.ts';
export { MemoryBus } from './feed/memory-bus.ts';
export { KafkaBus, type KafkaBusOptions } from './feed/kafka-bus.ts';
export {
  feedEventDigest, recordToFeedEvent, outboxHeadersToKafka, outboxHeadersToFeed, isMarkerEvent, markerSealContext, encodeMarker,
  decodeMarker, markerKey, encodeClosure, decodeClosure, encodeRelayProgress, decodeRelayProgress, closureTopic, cdcTopic,
  relayProgressTopic, topicKind, type ClosureMessage,
} from './feed/wire.ts';
export {
  OutboxRelay, parseCdcMessage, changefeedStatement, ensureChangefeed, cancelChangefeeds, changefeedJobs,
  type RelayOptions, type ChangefeedOptions, type CdcMessage, type CdcOutboxRow,
} from './relay/relay.ts';
export { ClosureEmitter, emitterSlotKind, type ClosureEmitterOptions, type FeedSeqReader } from './closure/emitter.ts';
export { FeedConsumerRuntime, type FeedConsumerOptions, type ConsumerAlert } from './consumer/consumer.ts';
export { PgGapFill, MemoryGapFill, type GapFillSource, type GapFillRow, type PgGapFillOptions } from './consumer/gapfill.ts';
export { REPORT, SlotReport, markerChunks, outcomeStream, reportsMarkers, type LeaseAnswer, type ReaderChannel, type ReadLease } from './report/report.ts';
export { StatusReader, ceilMicrosLiteral, type StatusReaderOptions, type ReadLeaseHolder } from './status/reader.ts';
export { SlotMapCache, SLOT_MAP_TOPIC, fixedSlotMap, publishSlotMap, slotOfInMap, encodeSlotMap, decodeSlotMap, type SlotMapCacheOptions } from './placement/slot-map.ts';
export { producerAcls, aclCommands, kafkajsAcls, checkAcls, holderPrincipal, relayPrincipal, closureEmitterPrincipal, type TopicAcl, type ExtraProducers, type AclOptions } from './acl/kafka-acl.ts';

// TODO(S-PLAT-I1 item 15, C01 §3.1–§3.6): TLA+ model of sessions, revocation, resume, re-home, epochs, slot batches,
//   handoff, read leases, report position, marker chain, relay progress and closure; TLC in CI.
// TODO(S-PLAT-I1 item 16, C01 §3.1, §3.2, §3.5): Jepsen-style harness on the dev cell (partitions, pauses past
//   session_ttl, delayed renewals, Ambiguous commits, crashes in acquisition/handoff/re-home/resume, a holder killed
//   between commit and publish while one relay lags); 24 h with no violation.
