import { writeFile } from 'node:fs/promises';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { format, resolveConfig } from 'prettier';

async function generate(): Promise<void> {
  process.env.SKIP_DATABASE_CONNECT = 'true';
  process.env.SKIP_REDIS_CONNECT = 'true';
  process.env.DATABASE_URL ??= 'postgresql://unused:unused@localhost:5432/unused';
  process.env.REDIS_URL ??= 'redis://localhost:6379/0';
  process.env.JWT_SECRET ??= 'openapi-only-secret-at-least-32-characters';
  process.env.FIELD_ENCRYPTION_KEYS ??= 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  process.env.ACTIVE_FIELD_KEY_ID ??= 'v1';

  const [{ NestFactory }, { AppModule }, { buildOpenApi }] = await Promise.all([
    import('@nestjs/core'),
    import('../src/app.module'),
    import('../src/bootstrap'),
  ]);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error'] });
  const document = buildOpenApi(app);
  const prettierConfig = (await resolveConfig('openapi.json')) ?? {};
  const contents = await format(JSON.stringify(document), { ...prettierConfig, parser: 'json' });
  await writeFile('openapi.json', contents, 'utf8');
  await app.close();
}

generate().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
