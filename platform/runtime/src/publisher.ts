import { Kafka, type Producer, logLevel } from 'kafkajs';
import './feed/kafkajs-request-queue.ts';
import type { OutboxMessage } from './batch/attempt.ts';

/** Direct publish after Committed (C01 §3.5). Best effort: the changefeed relay is the guaranteed path (I1b). */
export interface Publisher {
  publish(messages: OutboxMessage[]): Promise<void>;
  close(): Promise<void>;
}

export class MemoryPublisher implements Publisher {
  readonly sent: OutboxMessage[] = [];
  failNext = 0;
  async publish(messages: OutboxMessage[]): Promise<void> {
    if (this.failNext > 0) { this.failNext -= 1; throw new Error('injected publish failure'); }
    this.sent.push(...messages);
  }
  async close(): Promise<void> {}
}

export interface KafkaPublisherOptions { brokers: string[]; clientId: string; transactionalId?: string }

/** Idempotent producer, acks=all (C01 §3.5). Principal `<kind>-holder` (ACLs: TODO I1b, C01 §2.5). */
export class KafkaPublisher implements Publisher {
  private readonly producer: Producer;
  private connected: Promise<void> | undefined;

  constructor(o: KafkaPublisherOptions) {
    const kafka = new Kafka({ clientId: o.clientId, brokers: o.brokers, logLevel: logLevel.WARN });
    this.producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1, allowAutoTopicCreation: false });
  }

  private connect(): Promise<void> {
    this.connected ??= this.producer.connect();
    return this.connected;
  }

  async publish(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.connect();
    const byTopic = new Map<string, OutboxMessage[]>();
    for (const m of messages) byTopic.set(m.topic, [...(byTopic.get(m.topic) ?? []), m]);
    await this.producer.sendBatch({
      acks: -1,
      topicMessages: [...byTopic].map(([topic, ms]) => ({
        topic,
        messages: ms.map((m) => ({ key: Buffer.from(m.key), value: Buffer.from(m.value), headers: m.headers })),
      })),
    });
  }

  async close(): Promise<void> {
    if (this.connected) await this.producer.disconnect();
  }
}
