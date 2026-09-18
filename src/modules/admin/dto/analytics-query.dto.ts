import { ApiProperty } from '@nestjs/swagger';
import { IsDateString } from 'class-validator';

export class AnalyticsQueryDto {
  @ApiProperty({ example: '2026-09-01T00:00:00.000Z' })
  @IsDateString()
  from!: string;

  @ApiProperty({ example: '2026-10-01T00:00:00.000Z' })
  @IsDateString()
  to!: string;
}
