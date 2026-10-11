import { Module } from '@nestjs/common';
import { RatingModule } from '../rating/rating.module';
import { MeteringController } from './metering.controller';

@Module({ imports: [RatingModule], controllers: [MeteringController] })
export class MeteringModule {}
