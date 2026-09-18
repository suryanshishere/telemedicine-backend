import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { envValidationSchema } from '../config/env.validation';
import { DatabaseModule } from '../database/database.module';
import { OutboxService } from './outbox.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validationSchema: envValidationSchema }),
    LoggerModule.forRoot(),
    DatabaseModule,
  ],
  providers: [OutboxService],
})
export class WorkerModule {}
