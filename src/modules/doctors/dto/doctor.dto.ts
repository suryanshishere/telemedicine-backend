import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateDoctorActivationDto {
  @ApiProperty({ description: 'Approve or deactivate a verified doctor profile' })
  @IsBoolean()
  active!: boolean;
}

export class DoctorSearchDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  specialization?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minFeeCents?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxFeeCents?: number;

  @ApiPropertyOptional({
    description: 'Only doctors with an available slot at/after this UTC time',
  })
  @IsOptional()
  @IsDateString()
  availableFrom?: string;
}

export class CreateAvailabilityDto {
  @ApiProperty({ example: '2026-10-01T09:00:00.000Z' })
  @IsDateString()
  startsAt!: string;

  @ApiProperty({ example: '2026-10-01T09:30:00.000Z' })
  @IsDateString()
  endsAt!: string;
}

export class AvailabilityQueryDto {
  @ApiProperty({ example: '2026-10-01T00:00:00.000Z' })
  @IsDateString()
  from!: string;

  @ApiProperty({ example: '2026-11-01T00:00:00.000Z' })
  @IsDateString()
  to!: string;
}
