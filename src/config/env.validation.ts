import Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3000),
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgresql', 'postgres'] })
    .required(),
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .required(),
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_TTL_SECONDS: Joi.number().integer().min(60).default(900),
  REFRESH_TOKEN_TTL_DAYS: Joi.number().integer().min(1).max(365).default(30),
  FIELD_ENCRYPTION_KEYS: Joi.string().required(),
  ACTIVE_FIELD_KEY_ID: Joi.string().required(),
  ALLOWED_ORIGINS: Joi.string().default('http://localhost:3001'),
  RATE_LIMIT_MAX: Joi.number().integer().min(1).default(100),
  RATE_LIMIT_WINDOW_SECONDS: Joi.number().integer().min(1).default(60),
  TRUST_PROXY_HOPS: Joi.number().integer().min(0).max(5).default(0),
  OTEL_EXPORTER_OTLP_ENDPOINT: Joi.string().uri().optional().allow(''),
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent')
    .default('info'),
  OUTBOX_POLL_INTERVAL_MS: Joi.number().integer().min(100).default(1000),
  OUTBOX_MAX_ATTEMPTS: Joi.number().integer().min(1).max(30).default(8),
  SKIP_DATABASE_CONNECT: Joi.boolean().default(false),
  SKIP_REDIS_CONNECT: Joi.boolean().default(false),
});
