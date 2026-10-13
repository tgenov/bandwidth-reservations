/**
 * Wait until a new topic's partitions all have a leader. kafkajs `createTopics({ waitForLeaders: true })`
 * retries only LEADER_NOT_AVAILABLE; when the broker's metadata cache has not caught up with the controller
 * yet (a busy cell), the metadata request answers UNKNOWN_TOPIC_OR_PARTITION and createTopics fails.
 * This polls the metadata with a bound instead, and fails with a message that names the topic.
 */
import { systemClock, type WallClock } from '../clock.ts';

export type TopicMetadataFetch = (topic: string) => Promise<{ topics: Array<{ name: string; partitions: Array<{ partitionId: number; leader: number }> }> }>;

/** Metadata errors that a topic shows while its creation propagates. */
const NOT_YET = new Set(['UNKNOWN_TOPIC_OR_PARTITION', 'LEADER_NOT_AVAILABLE']);

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitForTopicLeaders(fetch: TopicMetadataFetch, topic: string, partitions: number,
  o: { timeoutMs?: number; pollMs?: number; wallMs?: WallClock; sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const timeoutMs = o.timeoutMs ?? 30_000;
  const pollMs = o.pollMs ?? 100;
  const wallMs = o.wallMs ?? systemClock;
  const sleep = o.sleep ?? realSleep;
  const start = wallMs();
  for (;;) {
    let last: string;
    try {
      const m = await fetch(topic);
      const ps = m.topics.find((t) => t.name === topic)?.partitions ?? [];
      const ledCount = ps.filter((p) => p.leader >= 0).length;
      if (ps.length >= partitions && ledCount === ps.length) return;
      last = `${ledCount} of ${partitions} partitions with a leader`;
    } catch (e) {
      const type = (e as { type?: unknown }).type;
      if (typeof type !== 'string' || !NOT_YET.has(type)) throw e;
      last = type;
    }
    if (wallMs() - start + pollMs > timeoutMs) {
      throw new Error(`topic ${topic}: the leaders of ${partitions} partitions were not ready within ${timeoutMs} ms (last: ${last})`);
    }
    await sleep(pollMs);
  }
}
