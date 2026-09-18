import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'patient@example.com' })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ minLength: 12, example: 'Str0ng!Passphrase' })
  @IsString()
  @Length(12, 128)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$/, {
    message: 'password must contain upper, lower, number, and symbol characters',
  })
  password!: string;

  @ApiProperty({ example: 'Aarav Sharma' })
  @IsString()
  @Length(2, 120)
  fullName!: string;

  @ApiPropertyOptional({ enum: [Role.PATIENT, Role.DOCTOR], default: Role.PATIENT })
  @IsOptional()
  @IsEnum(Role)
  @Matches(/^(PATIENT|DOCTOR)$/)
  role: Role = Role.PATIENT;

  @ApiPropertyOptional({ example: '+919876543210' })
  @IsOptional()
  @IsPhoneNumber()
  phone?: string;

  @ApiPropertyOptional({ example: 'Ayurveda' })
  @ValidateIf((dto: RegisterDto) => dto.role === Role.DOCTOR)
  @IsString()
  @Length(2, 100)
  specialization?: string;

  @ApiPropertyOptional({ example: 'MED-12345' })
  @ValidateIf((dto: RegisterDto) => dto.role === Role.DOCTOR)
  @IsString()
  @Length(3, 100)
  licenseNumber?: string;

  @ApiPropertyOptional({ example: 150000, description: 'Fee in minor currency units (paise)' })
  @ValidateIf((dto: RegisterDto) => dto.role === Role.DOCTOR)
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  consultationFeeCents?: number;
}
