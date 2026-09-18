import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import {
  RATE_LIMIT_KEY,
  SKIP_RATE_LIMIT_KEY,
} from '../../src/common/decorators/rate-limit.decorator';
import { RateLimitGuard } from '../../src/common/guards/rate-limit.guard';
import { MetricsService } from '../../src/common/observability/metrics.service';
import { RedisService } from '../../src/common/services/redis.service';
import { AuthUser } from '../../src/common/types/auth-user';
import { PrismaService } from '../../src/database/prisma.service';
import { HealthController } from '../../src/modules/health/health.controller';

const patient: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'patient@example.test',
  role: Role.PATIENT,
  mfa: false,
};

function rateHarness(options?: {
  skip?: boolean;
  override?: { max: number; windowSeconds: number };
  redisResult?: [number, number] | null;
  redisError?: Error;
}) {
  const request = {
    user: patient,
    ip: '127.0.0.1',
    method: 'POST',
    route: { path: '/v1/bookings' },
    path: '/v1/bookings',
  };
  const response = { setHeader: jest.fn() };
  const context = {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: jest.fn(() => ({
      getRequest: jest.fn(() => request),
      getResponse: jest.fn(() => response),
    })),
  } as unknown as ExecutionContext;
  const reflector = {
    getAllAndOverride: jest.fn((key: string) => {
      if (key === SKIP_RATE_LIMIT_KEY) return options?.skip ?? false;
      if (key === RATE_LIMIT_KEY) return options?.override;
      return undefined;
    }),
  };
  const config = {
    get: jest.fn((key: string, fallback: number) => {
      if (key === 'RATE_LIMIT_MAX') return 100;
      if (key === 'RATE_LIMIT_WINDOW_SECONDS') return 60;
      return fallback;
    }),
  };
  const incrementWithWindow = options?.redisError
    ? jest.fn().mockRejectedValue(options.redisError)
    : jest.fn().mockResolvedValue(options?.redisResult ?? [1, 60]);
  const redis = { incrementWithWindow };
  const guard = new RateLimitGuard(
    reflector as unknown as Reflector,
    config as unknown as ConfigService,
    redis as unknown as RedisService,
  );
  return { guard, context, request, response, reflector, config, redis };
}

describe('RateLimitGuard', () => {
  it('fully bypasses storage and headers for explicitly skipped operational routes', async () => {
    const { guard, context, redis, response } = rateHarness({ skip: true });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(redis.incrementWithWindow).not.toHaveBeenCalled();
    expect(response.setHeader).not.toHaveBeenCalled();
  });

  it('uses route-specific limits and the authenticated user as the distributed key', async () => {
    const { guard, context, redis, response, config } = rateHarness({
      override: { max: 2, windowSeconds: 30 },
      redisResult: [1, 27],
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(redis.incrementWithWindow).toHaveBeenCalledWith(
      `rate:POST:/v1/bookings:${patient.id}`,
      30,
    );
    expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', 2);
    expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 1);
    expect(config.get).not.toHaveBeenCalled();
  });

  it('returns a 429 with retry guidance after a distributed limit is exceeded', async () => {
    const { guard, context, response } = rateHarness({
      override: { max: 2, windowSeconds: 30 },
      redisResult: [3, 17],
    });

    let thrown: unknown;
    try {
      await guard.canActivate(context);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 0);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', 17);
  });

  it('fails over to a bounded in-process counter when Redis is unavailable', async () => {
    const { guard, context, response } = rateHarness({
      override: { max: 1, windowSeconds: 60 },
      redisError: new Error('redis unavailable'),
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 429 });
    expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 0);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', 60);
  });

  it('uses the client address for unauthenticated callers', async () => {
    const { guard, context, request, redis } = rateHarness({ redisResult: [1, 60] });
    request.user = undefined as unknown as AuthUser;

    await guard.canActivate(context);

    expect(redis.incrementWithWindow).toHaveBeenCalledWith('rate:POST:/v1/bookings:127.0.0.1', 60);
  });
});

function healthHarness(databaseHealthy: boolean, redisHealthy: boolean) {
  const prisma = { isHealthy: jest.fn().mockResolvedValue(databaseHealthy) };
  const redis = { isHealthy: jest.fn().mockReturnValue(redisHealthy) };
  const metrics = { render: jest.fn().mockResolvedValue('# HELP test_metric\n') };
  const controller = new HealthController(
    prisma as unknown as PrismaService,
    redis as unknown as RedisService,
    metrics as unknown as MetricsService,
  );
  return { controller, prisma, redis, metrics };
}

describe('HealthController', () => {
  it('reports process liveness independently of dependencies', () => {
    const { controller } = healthHarness(false, false);

    const result = controller.live();

    expect(result.status).toBe('ok');
    expect(new Date(result.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('fails readiness when the required database dependency is unavailable', async () => {
    const { controller } = healthHarness(false, true);

    let thrown: unknown;
    try {
      await controller.ready();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect((thrown as HttpException).getResponse()).toEqual({
      status: 'not_ready',
      checks: { database: false, redis: true },
    });
  });

  it('reports degraded readiness when Redis is down because safe fallbacks exist', async () => {
    const { controller } = healthHarness(true, false);

    await expect(controller.ready()).resolves.toEqual(
      expect.objectContaining({
        status: 'degraded',
        checks: { database: true, redis: false },
        timestamp: expect.any(String),
      }),
    );
  });

  it('reports full readiness and delegates Prometheus rendering', async () => {
    const { controller, metrics } = healthHarness(true, true);

    await expect(controller.ready()).resolves.toEqual(
      expect.objectContaining({ status: 'ready', checks: { database: true, redis: true } }),
    );
    await expect(controller.metricsOutput()).resolves.toBe('# HELP test_metric\n');
    expect(metrics.render).toHaveBeenCalledTimes(1);
  });
});
