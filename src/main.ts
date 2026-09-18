import 'reflect-metadata';
import './tracing';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { buildOpenApi, configureApplication } from './bootstrap';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  configureApplication(app);
  SwaggerModule.setup('docs', app, buildOpenApi(app), {
    jsonDocumentUrl: 'docs/openapi.json',
    swaggerOptions: { persistAuthorization: true },
  });
  const config = app.get(ConfigService);
  await app.listen(config.get<number>('PORT', 3000), '0.0.0.0');
}

void bootstrap();
