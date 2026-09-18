import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter';

export function configureApplication(app: NestExpressApplication): void {
  const config = app.get(ConfigService);
  app.useLogger(app.get(Logger));
  app.set('trust proxy', config.get<number>('TRUST_PROXY_HOPS', 0));
  app.use(helmet());
  app.use(compression());
  app.enableCors({
    origin: config
      .get<string>('ALLOWED_ORIGINS', '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id'],
    maxAge: 86_400,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      stopAtFirstError: false,
    }),
  );
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.enableShutdownHooks();
}

export function buildOpenApi(app: NestExpressApplication) {
  const config = new DocumentBuilder()
    .setTitle('Amrutam Telemedicine API')
    .setDescription('Secure, idempotent REST API for telemedicine workflows')
    .setVersion('1.0.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .addServer('/')
    .build();
  return SwaggerModule.createDocument(app, config);
}
