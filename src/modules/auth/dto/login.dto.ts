import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'patient@example.com' })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty()
  @IsString()
  @Length(1, 128)
  password!: string;

  @ApiPropertyOptional({ example: '123456' })
  @IsOptional()
  @IsString()
  @Length(6, 6)
  totpCode?: string;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  @Length(40, 256)
  refreshToken!: string;
}

export class MfaVerifyDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @Length(6, 6)
  code!: string;
}
