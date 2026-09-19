# Amrutam Telemedicine Backend

NestJS REST API for the Amrutam backend assignment. It supports secure authentication, doctor discovery and availability, consultation booking, prescriptions, payments, audit logs, and admin analytics.

## Tech stack

- Node.js 22, TypeScript, and NestJS
- PostgreSQL with Prisma
- Redis for rate limiting and short-lived caches
- Jest, Docker Compose, OpenAPI, Prometheus, and OpenTelemetry

## Implemented features

- Patient, doctor, and admin roles with JWT access/refresh tokens
- Argon2 password hashing, refresh-token rotation, TOTP MFA, RBAC, and rate limiting
- Doctor registration, admin activation, search, and availability management
- Concurrency-safe and idempotent consultation booking
- Consultation status transitions and encrypted prescriptions
- Payment status management
- Append-only audit logs and admin analytics
- Transactional outbox worker for asynchronous tasks
- Health checks, metrics, structured logs, and tracing

## Run locally

Requirements: Node.js 22+, PostgreSQL 16+, and Redis 7+.

```bash
npm ci
cp .env.example .env
npm run prisma:migrate
npm run start:dev
```

On PowerShell, use `Copy-Item .env.example .env` instead of `cp`.

Run the worker in another terminal:

```bash
npm run dev:worker
```

The API runs at `http://localhost:3000`; Swagger UI is available at `http://localhost:3000/docs`.

## Run with Docker

```bash
cp .env.example .env
docker compose up --build -d
```

Check the service with `curl http://localhost:3000/health/ready` and stop it with `docker compose down`.

## Admin setup

Create the initial administrator after the database is migrated:

```bash
SEED_ADMIN_EMAIL=admin@example.com \
SEED_ADMIN_PASSWORD='Change-Me-Now!123' \
npm run prisma:seed
```

The admin should enroll in MFA before using protected admin endpoints.

## Validation

```bash
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run build
```

## API overview

All application routes use the `/v1` prefix.

| Area           | Main routes                                                                  |
| -------------- | ---------------------------------------------------------------------------- |
| Authentication | `/v1/auth/register`, `/login`, `/refresh`, `/logout`, `/mfa/*`               |
| Users          | `/v1/users/me`, `/v1/admin/users`                                            |
| Doctors        | `/v1/doctors`, `/v1/doctors/:id/availability`, `/v1/doctors/me/availability` |
| Consultations  | `/v1/bookings`, `/v1/consultations`                                          |
| Payments       | `/v1/admin/payments/:id/status`                                              |
| Admin          | `/v1/admin/analytics`, `/v1/admin/audit-logs`                                |
| Operations     | `/health/live`, `/health/ready`, `/metrics`                                  |

Creating availability, bookings, and prescriptions requires an `Idempotency-Key` header. See [openapi.json](openapi.json) or Swagger UI for request and response schemas.

## Documentation

- [Architecture](docs/architecture.md)
- [Security](docs/security.md)
- [Assumptions](docs/assumptions.md)
- [Demo script](docs/demo-script.md)
