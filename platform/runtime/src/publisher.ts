import { Producer, ProduceAcks, compatibilityPartitioner } from '@platformatic/kafka';
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

/**
 * Idempotent producer, acks=all (C01 §3.5). Principal `<kind>-holder` (ACLs: TODO I1b, C01 §2.5).
 * The key selects the partition with the Java-compatible partitioner (E-001 §9), as `partitionForKey`.
 */
export class KafkaPublisher implements Publisher {
  private readonly producer: Producer;

  constructor(o: KafkaPublisherOptions) {
    this.producer = new Producer({
      clientId: o.clientId, bootstrapBrokers: o.brokers, idempotent: true, acks: ProduceAcks.ALL,
      autocreateTopics: false, maxInflights: 1, partitioner: compatibilityPartitioner,
    });
  }

  async publish(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.producer.send({
      messages: messages.map((m) => ({
        topic: m.topic, key: Buffer.from(m.key), value: Buffer.from(m.value),
        headers: new Map(Object.entries(m.headers).map(([k, v]) => [Buffer.from(k, 'utf8'), typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v)])),
      })),
    });
  }

  async close(): Promise<void> {
    await this.producer.close();
  }
}
