import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;
  private ready = false;

  constructor(private readonly config: ConfigService) {
    this.client = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1_000,
    });
    this.client.on('ready', () => (this.ready = true));
    this.client.on('close', () => (this.ready = false));
    this.client.on('error', (error) => this.logger.warn(`Redis unavailable: ${error.message}`));
  }

  async onModuleInit(): Promise<void> {
    if (this.config.get<boolean>('SKIP_REDIS_CONNECT')) return;
    try {
      await this.client.connect();
    } catch (error) {
      this.logger.warn(`Starting with in-process fallbacks: ${(error as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.status !== 'end') this.client.disconnect();
  }

  isHealthy(): boolean {
    return this.ready;
  }

  async incrementWithWindow(key: string, windowSeconds: number): Promise<[number, number] | null> {
    if (!this.ready) return null;
    const result = (await this.client.eval(
      "local count=redis.call('INCR',KEYS[1]); if count==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return {count,redis.call('TTL',KEYS[1])}",
      1,
      key,
      windowSeconds,
    )) as [number, number];
    return [Number(result[0]), Number(result[1])];
  }

  async getJson<T>(key: string): Promise<T | null> {
    if (!this.ready) return null;
    try {
      const value = await this.client.get(key);
      return value ? (JSON.parse(value) as T) : null;
    } catch (error) {
      this.logger.warn(`Redis cache read failed: ${(error as Error).message}`);
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.ready) return;
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (error) {
      this.logger.warn(`Redis cache write failed: ${(error as Error).message}`);
    }
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    if (!this.ready) return;
    try {
      let cursor = '0';
      do {
        const [next, keys] = await this.client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
        cursor = next;
        if (keys.length) await this.client.del(...keys);
      } while (cursor !== '0');
    } catch (error) {
      this.logger.warn(`Redis cache invalidation failed: ${(error as Error).message}`);
    }
  }
}
