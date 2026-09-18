import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import {
  RATE_LIMIT_KEY,
  RateLimitOptions,
  SKIP_RATE_LIMIT_KEY,
} from '../decorators/rate-limit.decorator';
import { AuthUser } from '../types/auth-user';
import { RedisService } from '../services/redis.service';

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly fallback = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skipped = this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skipped) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const response = context.switchToHttp().getResponse<Response>();
    const override = this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const max = override?.max ?? this.config.get<number>('RATE_LIMIT_MAX', 100);
    const windowSeconds =
      override?.windowSeconds ?? this.config.get<number>('RATE_LIMIT_WINDOW_SECONDS', 60);
    const identity = request.user?.id ?? request.ip ?? 'unknown';
    const routeInfo = request.route as { path?: string } | undefined;
    const route = `${request.method}:${routeInfo?.path ?? request.path}`;
    const key = `rate:${route}:${identity}`;

    let count: number;
    let retryAfter: number;
    try {
      const redisResult = await this.redis.incrementWithWindow(key, windowSeconds);
      if (redisResult) {
        [count, retryAfter] = redisResult;
      } else {
        [count, retryAfter] = this.incrementFallback(key, windowSeconds);
      }
    } catch {
      [count, retryAfter] = this.incrementFallback(key, windowSeconds);
    }

    response.setHeader('X-RateLimit-Limit', max);
    response.setHeader('X-RateLimit-Remaining', Math.max(0, max - count));
    if (count > max) {
      response.setHeader('Retry-After', Math.max(1, retryAfter));
      throw new HttpException('Rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }

  private incrementFallback(key: string, windowSeconds: number): [number, number] {
    const now = Date.now();
    const existing = this.fallback.get(key);
    if (!existing || existing.resetAt <= now) {
      const next = { count: 1, resetAt: now + windowSeconds * 1_000 };
      this.fallback.set(key, next);
      if (this.fallback.size > 10_000) this.pruneFallback(now);
      return [1, windowSeconds];
    }
    existing.count += 1;
    return [existing.count, Math.ceil((existing.resetAt - now) / 1_000)];
  }

  private pruneFallback(now: number): void {
    for (const [key, value] of this.fallback) {
      if (value.resetAt <= now) this.fallback.delete(key);
    }
    while (this.fallback.size > 10_000) {
      const oldestKey = this.fallback.keys().next().value;
      if (!oldestKey) break;
      this.fallback.delete(oldestKey);
    }
  }
}
