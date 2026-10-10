import { Module } from '@nestjs/common';
import { ExposureModule } from '../exposure/exposure.module';
import { LedgerModule } from '../ledger/ledger.module';
import { RatesService } from './rates.service';
import { RatingService } from './rating.service';

@Module({
  imports: [LedgerModule, ExposureModule],
  providers: [RatesService, RatingService],
  exports: [RatingService, RatesService],
})
export class RatingModule {}
