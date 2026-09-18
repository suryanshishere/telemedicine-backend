import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { envValidationSchema } from './config/env.validation';
import { CommonModule } from './common/common.module';
import { DatabaseModule } from './database/database.module';
import { AdminModule } from './modules/admin/admin.module';
import { AuthModule } from './modules/auth/auth.module';
import { ConsultationsModule } from './modules/consultations/consultations.module';
import { DoctorsModule } from './modules/doctors/doctors.module';
import { HealthModule } from './modules/health/health.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validationSchema: envValidationSchema }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level: config.get<string>('LOG_LEVEL', 'info'),
          genReqId: (request, response) => {
            const supplied = request.headers['x-request-id'];
            const id =
              typeof supplied === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(supplied)
                ? supplied
                : randomUUID();
            response.setHeader('x-request-id', id);
            return id;
          },
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.body.password',
              'req.body.totpCode',
              'req.body.code',
              'req.body.refreshToken',
              'res.headers["set-cookie"]',
            ],
            censor: '[REDACTED]',
          },
        },
      }),
    }),
    DatabaseModule,
    CommonModule,
    AuthModule,
    UsersModule,
    DoctorsModule,
    ConsultationsModule,
    PaymentsModule,
    AdminModule,
    HealthModule,
  ],
})
export class AppModule {}
