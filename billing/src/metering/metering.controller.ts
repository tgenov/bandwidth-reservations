import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { TOPICS } from '../exposure/events';
import { RatingService } from '../rating/rating.service';
import { FlowRecordDto } from './flow-record.dto';

@Controller()
export class MeteringController {
  private readonly log = new Logger(MeteringController.name);

  constructor(private readonly rating: RatingService) {}

  /**
   * Fire-and-forget: the router expects no answer. Delivery is at-least-once,
   * because Nest awaits this handler before kafkajs commits the offset, so a
   * crash mid-handler means redelivery. That is safe only because ingest is
   * idempotent by (exporterId, sequence).
   */
  @EventPattern(TOPICS.flowRecords)
  async onFlowRecord(
    @Payload() record: FlowRecordDto, // validated by the inherited global ValidationPipe
  ): Promise<void> {
    const result = await this.rating.ingest(record);
    if (result === 'duplicate') this.log.debug(`duplicate ${record.exporterId}/${record.sequence}`);
  }
}
