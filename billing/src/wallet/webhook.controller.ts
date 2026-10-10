import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { PaymentEventDto } from './payment-event.dto';
import { WalletService } from './wallet.service';

// HTTP edge: the payment provider calls us. Validation comes from the global
// ValidationPipe registered in main.ts.
@Controller()
export class WebhookController {
  constructor(private readonly wallets: WalletService) {}

  /** Always 200 for a well-formed event, duplicates included, so the provider stops retrying. */
  @Post('webhooks/payments')
  @HttpCode(200)
  async payment(@Body() event: PaymentEventDto) {
    return { result: await this.wallets.applyPaymentEvent(event) };
  }

  @Get('wallets/:customerId')
  wallet(@Param('customerId') customerId: string) {
    return this.wallets.standing(customerId);
  }
}
