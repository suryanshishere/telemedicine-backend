import { Controller, Get, Header, HttpException, HttpStatus } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { SkipRateLimit } from '../../common/decorators/rate-limit.decorator';
import { MetricsService } from '../../common/observability/metrics.service';
import { RedisService } from '../../common/services/redis.service';
import { PrismaService } from '../../database/prisma.service';

@ApiTags('operations')
@Public()
@SkipRateLimit()
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
  ) {}

  @Get('health/live')
  live() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('health/ready')
  async ready() {
    const checks = { database: await this.prisma.isHealthy(), redis: this.redis.isHealthy() };
    if (!checks.database) {
      throw new HttpException({ status: 'not_ready', checks }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return {
      status: checks.redis ? 'ready' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    };
  }

  @ApiExcludeEndpoint()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Get('metrics')
  metricsOutput(): Promise<string> {
    return this.metrics.render();
  }
}
