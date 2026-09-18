import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(private readonly config: ConfigService) {
    super({
      log:
        config.get<string>('NODE_ENV') === 'development'
          ? [
              { emit: 'event', level: 'warn' },
              { emit: 'event', level: 'error' },
            ]
          : [{ emit: 'event', level: 'error' }],
    });
  }

  async onModuleInit(): Promise<void> {
    if (this.config.get<boolean>('SKIP_DATABASE_CONNECT')) return;
    await this.$connect();
    this.logger.log('PostgreSQL connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
