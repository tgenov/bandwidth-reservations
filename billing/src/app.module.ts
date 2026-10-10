import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { billingConfig } from './billing.config';
import { DatabaseModule } from './database/database.module';
import { MeteringModule } from './metering/metering.module';
import { WalletModule } from './wallet/wallet.module';

// Feature modules own their controllers; shared services (ledger, rating,
// exposure) are imported where used rather than made global.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [billingConfig] }),
    DatabaseModule,
    MeteringModule,
    WalletModule,
  ],
})
export class AppModule {}
