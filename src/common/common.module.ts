import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuditService } from './services/audit.service';
import { CryptoService } from './services/crypto.service';
import { IdempotencyService } from './services/idempotency.service';
import { RedisService } from './services/redis.service';
import { RateLimitGuard } from './guards/rate-limit.guard';
import { RolesGuard } from './guards/roles.guard';
import { MetricsService } from './observability/metrics.service';
import { MetricsInterceptor } from './observability/metrics.interceptor';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { MfaGuard } from './guards/mfa.guard';

@Global()
@Module({
  providers: [
    AuditService,
    CryptoService,
    IdempotencyService,
    RedisService,
    MetricsService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: MfaGuard },
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
  ],
  exports: [AuditService, CryptoService, IdempotencyService, RedisService, MetricsService],
})
export class CommonModule {}
