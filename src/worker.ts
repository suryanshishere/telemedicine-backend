import 'reflect-metadata';
import './tracing';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { OutboxService } from './outbox/outbox.service';
import { WorkerModule } from './outbox/worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));
  const logger = new Logger('OutboxWorker');
  const outbox = app.get(OutboxService);
  const config = app.get(ConfigService);
  const interval = config.get<number>('OUTBOX_POLL_INTERVAL_MS', 1_000);
  let stopping = false;

  const stop = async () => {
    stopping = true;
    await app.close();
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());

  logger.log(`Outbox worker started; poll interval ${interval}ms`);
  while (!stopping) {
    try {
      const processed = await outbox.processBatch();
      if (processed === 0) await sleep(interval);
    } catch (error) {
      logger.error('Outbox poll failed', (error as Error).stack);
      await sleep(Math.min(interval * 5, 10_000));
    }
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

void bootstrap();
