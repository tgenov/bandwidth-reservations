// Outbound fire-and-forget events. Services depend on this interface, not on
// ClientKafka, so tests can inject an in-memory publisher (see exposure.module).
export const BILLING_EVENTS = Symbol('BILLING_EVENTS');

export interface EventPublisher {
  emit(topic: string, payload: object): Promise<void>;
}

export const TOPICS = {
  flowRecords: 'flow-records',
  suspend: 'customer.suspend',
  resume: 'customer.resume',
  walletBalance: 'wallet.balance',
  admissionCheck: 'billing.admission-check',
} as const;
