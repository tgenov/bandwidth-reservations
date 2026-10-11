import { registerAs } from '@nestjs/config';

export type ExposurePolicy = 'reserve' | 'credit_limit';

// One typed config namespace. Services inject it with
// @Inject(billingConfig.KEY) and get ConfigType<typeof billingConfig>, so a
// typo in a setting name is a compile error rather than an undefined at runtime.
export const billingConfig = registerAs('billing', () => ({
  databaseUrl:
    process.env.BILLING_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55432/billing',
  kafkaBrokers: (process.env.KAFKA_BROKERS ?? 'localhost:59092').split(','),
  kafkaGroupId: process.env.KAFKA_GROUP_ID ?? 'billing',
  httpPort: Number(process.env.HTTP_PORT ?? 3000),
  // D19: what to do once a customer's usage outruns their wallet.
  exposurePolicy: (process.env.EXPOSURE_POLICY ?? 'reserve') as ExposurePolicy,
  creditLimitMicros: BigInt(process.env.CREDIT_LIMIT_MICROS ?? '0'),
  // Metering lag must cover every delay before usage is charged: transport,
  // the one-minute rating bucket and the watermark grace, not just transport.
  meteringLagSeconds: Number(process.env.METERING_LAG_SECONDS ?? 180),
  enforcementLagSeconds: Number(process.env.ENFORCEMENT_LAG_SECONDS ?? 60),
}));
