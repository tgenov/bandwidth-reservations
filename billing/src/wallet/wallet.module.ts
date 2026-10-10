import { Module } from '@nestjs/common';
import { ExposureModule } from '../exposure/exposure.module';
import { LedgerModule } from '../ledger/ledger.module';
import { WalletRpcController } from './wallet-rpc.controller';
import { WalletService } from './wallet.service';
import { WebhookController } from './webhook.controller';

@Module({
  imports: [LedgerModule, ExposureModule],
  controllers: [WebhookController, WalletRpcController],
  providers: [WalletService],
})
export class WalletModule {}
