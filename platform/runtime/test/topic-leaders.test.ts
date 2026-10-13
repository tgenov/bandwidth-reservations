/** Topic creation on Kafka waits, with a bound, until every partition of the new topic has a leader. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForTopicLeaders, type TopicMetadataFetch } from '../src/index.ts';

type Answer = { partitions: Array<{ partitionId: number; leader: number }> } | { error: string };

function steppedClock(): { wallMs: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let now = 1_791_878_186_248;
  const slept: number[] = [];
  return { wallMs: () => now, sleep: async (ms) => { slept.push(ms); now += ms; }, slept };
}

function metadata(answers: Answer[]): TopicMetadataFetch & { calls: number } {
  const f = Object.assign(async (topic: string) => {
    const a = answers[Math.min(f.calls, answers.length - 1)];
    f.calls += 1;
    if (!a) throw new Error('no answer set up');
    if ('error' in a) throw Object.assign(new Error(`metadata: ${a.error}`), { type: a.error });
    return { topics: [{ name: topic, partitions: a.partitions }] };
  }, { calls: 0 });
  return f;
}

const led = (n: number) => ({ partitions: Array.from({ length: n }, (_, i) => ({ partitionId: i, leader: 1 })) });

test('should return when the metadata shows every partition with a leader', async () => {
  const clock = steppedClock();
  const fetch = metadata([led(4)]);
  await waitForTopicLeaders(fetch, 't', 4, { timeoutMs: 1_000, pollMs: 50, ...clock });
  assert.equal(fetch.calls, 1);
  assert.deepEqual(clock.slept, []);
});

test('should poll again when the topic is not yet known or has no leader after creation', async () => {
  const clock = steppedClock();
  const fetch = metadata([
    { error: 'UNKNOWN_TOPIC_OR_PARTITION' },
    { error: 'LEADER_NOT_AVAILABLE' },
    { partitions: [{ partitionId: 0, leader: 1 }, { partitionId: 1, leader: -1 }] },
    { partitions: [{ partitionId: 0, leader: 1 }] },
    led(2),
  ]);
  await waitForTopicLeaders(fetch, 't', 2, { timeoutMs: 1_000, pollMs: 50, ...clock });
  assert.equal(fetch.calls, 5);
  assert.deepEqual(clock.slept, [50, 50, 50, 50]);
});

test('should fail with the topic, the bound and the last state when the leaders are not ready in time', async () => {
  const clock = steppedClock();
  const fetch = metadata([{ error: 'UNKNOWN_TOPIC_OR_PARTITION' }]);
  await assert.rejects(waitForTopicLeaders(fetch, 'link.schedule.v1', 4, { timeoutMs: 200, pollMs: 50, ...clock }), {
    message: 'topic link.schedule.v1: the leaders of 4 partitions were not ready within 200 ms (last: UNKNOWN_TOPIC_OR_PARTITION)',
  });
  assert.equal(fetch.calls, 5);
});

test('should fail at once on a metadata error that waiting cannot fix', async () => {
  const clock = steppedClock();
  const fetch = metadata([{ error: 'TOPIC_AUTHORIZATION_FAILED' }]);
  await assert.rejects(waitForTopicLeaders(fetch, 't', 1, { timeoutMs: 1_000, pollMs: 50, ...clock }), { message: 'metadata: TOPIC_AUTHORIZATION_FAILED' });
  assert.equal(fetch.calls, 1);
});
