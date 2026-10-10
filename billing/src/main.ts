import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AppModule } from './app.module';
import { billingConfig } from './billing.config';

/**
 * One process, two transports (a "hybrid" app): HTTP for payment webhooks and
 * Kafka for flow records and request-reply queries. Both share one DI container,
 * so the same LedgerService instance serves every entry point.
 */
export async function createApp(overrides?: (app: INestApplication) => void) {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  overrides?.(app);
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  const cfg = app.get<ReturnType<typeof billingConfig>>(billingConfig.KEY);
  app.connectMicroservice<MicroserviceOptions>(
    {
      transport: Transport.KAFKA,
      options: {
        client: { clientId: 'billing', brokers: cfg.kafkaBrokers },
        consumer: { groupId: cfg.kafkaGroupId }, // Nest appends "-server"
        // A brand-new consumer group starts at the oldest record, not the newest:
        // for billing, skipping records is lost revenue, re-reading is harmless.
        subscribe: { fromBeginning: true },
      },
    },
    // Lets the Kafka handlers use the global ValidationPipe too.
    { inheritAppConfig: true },
  );
  return app;
}

async function bootstrap() {
  const app = await createApp();
  await app.startAllMicroservices();
  await app.listen(app.get<ReturnType<typeof billingConfig>>(billingConfig.KEY).httpPort);
}

if (require.main === module) void bootstrap();
