import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { RequestContext } from '../../common/decorators/request-context.decorator';
import { AuditContext, AuthUser } from '../../common/types/auth-user';
import { AuthService } from './auth.service';
import { LoginDto, MfaVerifyDto, RefreshDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

@ApiTags('authentication')
@Controller('v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @RateLimit({ max: 5, windowSeconds: 60 })
  @Post('register')
  @ApiOperation({ summary: 'Register a patient or doctor account' })
  register(@Body() dto: RegisterDto, @RequestContext() context: AuditContext) {
    return this.auth.register(dto, context);
  }

  @Public()
  @RateLimit({ max: 10, windowSeconds: 60 })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  @ApiOperation({ summary: 'Authenticate with password and optional TOTP' })
  login(@Body() dto: LoginDto, @RequestContext() context: AuditContext) {
    return this.auth.login(dto, context);
  }

  @Public()
  @RateLimit({ max: 20, windowSeconds: 60 })
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  refresh(@Body() dto: RefreshDto, @RequestContext() context: AuditContext) {
    return this.auth.refresh(dto, context);
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout')
  async logout(
    @CurrentUser() user: AuthUser,
    @Body() dto: RefreshDto,
    @RequestContext() context: AuditContext,
  ): Promise<void> {
    await this.auth.logout(user.id, dto, context);
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('mfa/setup')
  setupMfa(@CurrentUser() user: AuthUser, @RequestContext() context: AuditContext) {
    return this.auth.setupMfa(user, context);
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('mfa/verify')
  verifyMfa(
    @CurrentUser() user: AuthUser,
    @Body() dto: MfaVerifyDto,
    @RequestContext() context: AuditContext,
  ) {
    return this.auth.verifyMfa(user, dto.code, context);
  }
}
