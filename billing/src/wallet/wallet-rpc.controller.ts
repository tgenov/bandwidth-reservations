import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { ExposureService } from '../exposure/exposure.service';
import { TOPICS } from '../exposure/events';
import { AdmissionQueryDto, CustomerQueryDto } from './payment-event.dto';
import { WalletService } from './wallet.service';

/**
 * Request-reply over Kafka: the caller blocks on an answer, which Nest sends
 * to `<topic>.reply`. Used where the caller cannot proceed without the result,
 * e.g. the reservation service asking whether a customer may book more (D19).
 */
@Controller()
export class WalletRpcController {
  constructor(
    private readonly wallets: WalletService,
    private readonly exposure: ExposureService,
  ) {}

  @MessagePattern(TOPICS.walletBalance)
  balance(@Payload() q: CustomerQueryDto) {
    return this.wallets.standing(q.customerId);
  }

  @MessagePattern(TOPICS.admissionCheck)
  async admission(@Payload() q: AdmissionQueryDto) {
    const r = await this.exposure.canAdmit(q.customerId, q.routeId, q.reservedMbps);
    return { allowed: r.allowed, availableMicros: r.available.toString() };
  }
}
