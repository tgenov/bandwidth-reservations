import { Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { ClientKafka, ClientsModule, Transport } from '@nestjs/microservices';
import { billingConfig } from '../billing.config';
import { LedgerModule } from '../ledger/ledger.module';
import { BILLING_EVENTS, EventPublisher } from './events';
import { ExposureService } from './exposure.service';

const KAFKA_PRODUCER = 'KAFKA_PRODUCER';

@Module({
  imports: [
    LedgerModule,
    // Producer-only client: this module emits events, it never awaits replies.
    ClientsModule.registerAsync([
      {
        name: KAFKA_PRODUCER,
        inject: [billingConfig.KEY],
        useFactory: (cfg: ConfigType<typeof billingConfig>) => ({
          transport: Transport.KAFKA,
          options: {
            client: { clientId: 'billing-events', brokers: cfg.kafkaBrokers },
            producerOnlyMode: true,
          },
        }),
      },
    ]),
  ],
  providers: [
    ExposureService,
    // Adapter from ClientKafka (Observable-based) to the EventPublisher port.
    // Tests replace BILLING_EVENTS with .overrideProvider() and never touch Kafka.
    {
      provide: BILLING_EVENTS,
      inject: [KAFKA_PRODUCER],
      useFactory: (client: ClientKafka): EventPublisher => ({
        emit: async (topic, payload) => {
          await new Promise<void>((resolve, reject) =>
            client.emit(topic, payload).subscribe({ complete: resolve, error: reject }),
          );
        },
      }),
    },
  ],
  exports: [ExposureService],
})
export class ExposureModule {}
