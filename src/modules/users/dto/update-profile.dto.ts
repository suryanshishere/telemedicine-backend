import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsPhoneNumber, IsString, Length } from 'class-validator';

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Aarav Sharma' })
  @IsOptional()
  @IsString()
  @Length(2, 120)
  fullName?: string;

  @ApiPropertyOptional({ example: '+919876543210' })
  @IsOptional()
  @IsPhoneNumber()
  phone?: string;

  @ApiPropertyOptional({ example: '1990-01-01' })
  @IsOptional()
  @IsDateString({ strict: true })
  dateOfBirth?: string;
}
