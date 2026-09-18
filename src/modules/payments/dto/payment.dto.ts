import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdatePaymentStatusDto {
  @ApiProperty({ enum: PaymentStatus })
  @IsEnum(PaymentStatus)
  status!: PaymentStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  providerReference?: string;
}
