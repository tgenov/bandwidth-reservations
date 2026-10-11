import { Type } from 'class-transformer';
import { IsDate, IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

/** One raw flow record as it arrives on the `flow-records` topic. */
export class FlowRecordDto {
  @IsString() @IsNotEmpty() exporterId: string;
  @IsInt() @Min(0) sequence: number;
  @IsString() @IsNotEmpty() reservationId: string;
  @IsInt() @Min(0) bytes: number;
  // JSON has no dates; @Type turns the ISO string into a Date before validation.
  @Type(() => Date) @IsDate() eventTime: Date;
}
