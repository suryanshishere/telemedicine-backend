import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ConsultationStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class BookConsultationDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  slotId!: string;

  @ApiProperty({ minLength: 3, maxLength: 2000 })
  @IsString()
  @Length(3, 2000)
  reason!: string;
}

export class ConsultationQueryDto {
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

  @ApiPropertyOptional({ enum: ConsultationStatus })
  @IsOptional()
  @IsEnum(ConsultationStatus)
  status?: ConsultationStatus;

  @ApiPropertyOptional({ example: '2026-10-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-11-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class UpdateConsultationStatusDto {
  @ApiProperty({ enum: ConsultationStatus })
  @IsEnum(ConsultationStatus)
  status!: ConsultationStatus;

  @ApiProperty({ description: 'Current resource version for optimistic concurrency' })
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @ApiPropertyOptional({ maxLength: 10_000 })
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  clinicalNotes?: string;
}

export class MedicationDto {
  @IsString()
  @Length(1, 200)
  name!: string;

  @IsString()
  @Length(1, 100)
  dosage!: string;

  @IsString()
  @Length(1, 100)
  frequency!: string;

  @IsString()
  @Length(1, 100)
  duration!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class CreatePrescriptionDto {
  @ApiProperty({ type: [MedicationDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => MedicationDto)
  medications!: MedicationDto[];

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  instructions?: string;
}
