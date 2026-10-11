import { Type } from 'class-transformer';
import { IsDate, IsIn, IsNotEmpty, IsNumberString, IsString } from 'class-validator';

/** A payment-provider webhook (M-Pesa style): may be late, repeated or out of order. */
export class PaymentEventDto {
  @IsString() @IsNotEmpty() providerTxnId: string;
  @IsIn(['completed', 'reversed']) type: 'completed' | 'reversed';
  @IsString() @IsNotEmpty() customerId: string;
  // A string, so amounts beyond 2^53 micros survive JSON intact.
  @IsNumberString({ no_symbols: true }) amountMicros: string;
  @Type(() => Date) @IsDate() occurredAt: Date;
}

export class CustomerQueryDto {
  @IsString() @IsNotEmpty() customerId: string;
}

export class AdmissionQueryDto {
  @IsString() @IsNotEmpty() customerId: string;
  @IsString() @IsNotEmpty() routeId: string;
  @Type(() => Number) reservedMbps: number;
}
