# Amrutam Telemedicine Backend

A production-oriented NestJS backend for secure telemedicine workflows. It implements user and doctor lifecycle management, MFA and RBAC, doctor discovery and availability, concurrency-safe booking, consultation state transitions, encrypted prescriptions, payments, append-only audit trails, analytics, observability, CI, and container/Kubernetes deployment assets.

The design is a modular monolith: PostgreSQL owns business truth and transactions, Redis is used only for rate limiting and reconstructable caches, and a transactional outbox moves slow side effects to independently scalable workers.

## Assignment coverage

| Requirement                     | Implementation                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Auth, roles, MFA                | Argon2id passwords; short-lived JWT access tokens; hashed, rotating refresh tokens with reuse detection; TOTP; patient/doctor/admin guards |
| Availability and booking        | PostgreSQL overlap exclusion constraint, optimistic slot claim, partial unique active-booking index, required idempotency keys             |
| Consultations and prescriptions | Explicit state machine, version checks, participant authorization, MFA-gated doctor writes, AES-256-GCM field encryption                   |
| Search and filtering            | Paginated doctor directory with name, specialization, fee, and availability filters; bounded consultation filters; trigram search indexes  |
| Compliance and audit            | Append-only `audit_logs`, request IDs, actor/resource/action metadata, PHI redaction, threat model and checklist                           |
| Admin analytics                 | Bounded time-range consultation, completion, cancellation, revenue, doctor, and patient aggregates                                         |
| Reliability and async work      | Atomic transactions, transactional outbox, `FOR UPDATE SKIP LOCKED` workers, leases, exponential backoff, dead letters                     |
| Observability                   | JSON logs, HTTP/runtime/outbox Prometheus metrics and alerts, Grafana dashboard, OpenTelemetry traces, Jaeger, liveness/readiness          |
| Delivery                        | Multi-stage non-root image, Docker Compose, Kubernetes manifests, HPA/PDB/network policy, GitHub Actions, Trivy and npm audit              |

## Quick start with Docker

Prerequisites: Docker Engine with Compose v2. Node.js is only needed for local development.

```bash
cp .env.example .env
docker compose up --build -d
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
```

On PowerShell, use `Copy-Item .env.example .env` instead of `cp`.

Compose starts PostgreSQL, Redis, a one-shot migration container, the API, the outbox worker, OpenTelemetry Collector, Jaeger, Prometheus, and Grafana. Local-only defaults are deliberately easy to replace; set strong secrets in `.env` before using any shared environment.

Create the first administrator, then enroll that account in MFA immediately:

```bash
docker compose run --rm \
  -e SEED_ADMIN_EMAIL=admin@example.test \
  -e SEED_ADMIN_PASSWORD='Change-Me-Now!123' \
  migrate npm run prisma:seed
```

Local endpoints:

- API: <http://localhost:3000>
- Swagger UI: <http://localhost:3000/docs>
- OpenAPI JSON: <http://localhost:3000/docs/openapi.json> or [`openapi.json`](openapi.json)
- Prometheus: <http://localhost:9090>
- Grafana: <http://localhost:3001>
- Jaeger: <http://localhost:16686>

Stop the stack with `docker compose down`. Add `-v` only when you intentionally want to delete local PostgreSQL, Redis, Prometheus, and Grafana data.

## Local development

Prerequisites: Node.js 22+, PostgreSQL 16+, and Redis 7+.

```bash
npm ci
cp .env.example .env
npm run prisma:generate
npm run prisma:migrate
npm run start:dev
```

Run the async worker in a second terminal:

```bash
npm run dev:worker
```

Useful commands:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:cov
npm run test:e2e
npm run build
npm run openapi:generate
npm audit --audit-level=high
```

## Critical workflow walkthrough

All timestamps are RFC 3339/ISO-8601 UTC values. Replace shell variables and future timestamps below with values from your responses.

### 1. Register, log in, and enroll MFA

Public doctor registration creates a pending, inactive doctor profile. An MFA-authenticated administrator must approve it before the doctor can publish availability or accept bookings.

```bash
curl -X POST http://localhost:3000/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"doctor@example.test","password":"Doctor!Pass123","fullName":"Dr Asha Rao","role":"DOCTOR","specialization":"Ayurveda","licenseNumber":"MED-12345","consultationFeeCents":150000}'

curl -X POST http://localhost:3000/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"doctor@example.test","password":"Doctor!Pass123"}'

curl -X POST http://localhost:3000/v1/auth/mfa/setup \
  -H "Authorization: Bearer $DOCTOR_TOKEN"

curl -X POST http://localhost:3000/v1/auth/mfa/verify \
  -H "Authorization: Bearer $DOCTOR_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"code":"123456"}'
```

`mfa/verify` returns a new token pair whose access token carries the verified MFA assurance. Use the analogous flow for the seeded admin, then approve the doctor:

```bash
curl -X PATCH http://localhost:3000/v1/admin/doctors/$DOCTOR_ID/activation \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"active":true}'
```

### 2. Publish and find availability

Every retryable create requires an 8-100 character `Idempotency-Key`.

```bash
curl -X POST http://localhost:3000/v1/doctors/me/availability \
  -H "Authorization: Bearer $DOCTOR_TOKEN" \
  -H 'Idempotency-Key: slot-demo-001' \
  -H 'Content-Type: application/json' \
  -d '{"startsAt":"2026-10-01T09:00:00.000Z","endsAt":"2026-10-01T09:30:00.000Z"}'

curl 'http://localhost:3000/v1/doctors?specialization=Ayurveda&availableFrom=2026-10-01T00:00:00.000Z'
curl "http://localhost:3000/v1/doctors/$DOCTOR_ID/availability?from=2026-10-01T00:00:00.000Z&to=2026-10-02T00:00:00.000Z"
```

### 3. Book safely and replay the request

Register and log in a patient, then submit this request twice with the same key and body:

```bash
curl -i -X POST http://localhost:3000/v1/bookings \
  -H "Authorization: Bearer $PATIENT_TOKEN" \
  -H 'Idempotency-Key: booking-demo-001' \
  -H 'Content-Type: application/json' \
  -d "{\"slotId\":\"$SLOT_ID\",\"reason\":\"Recurring migraine consultation\"}"
```

The replay returns the stored status/body and `Idempotency-Replayed: true`. Reusing the key with another payload returns `409`; racing different keys for the same slot yields exactly one booking. The consultation, pending payment, audit row, idempotency result, and outbox event commit atomically.

### 4. Advance the consultation and prescribe

The assigned doctor must have an MFA-verified access token. `expectedVersion` prevents stale concurrent updates.

```bash
curl -X PATCH http://localhost:3000/v1/consultations/$CONSULTATION_ID/status \
  -H "Authorization: Bearer $DOCTOR_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"status":"IN_PROGRESS","expectedVersion":1,"clinicalNotes":"Assessment recorded securely"}'

curl -X POST http://localhost:3000/v1/consultations/$CONSULTATION_ID/prescriptions \
  -H "Authorization: Bearer $DOCTOR_TOKEN" \
  -H 'Idempotency-Key: rx-demo-001' \
  -H 'Content-Type: application/json' \
  -d '{"medications":[{"name":"Demo medicine","dosage":"1 tablet","frequency":"once daily","duration":"3 days"}],"instructions":"Take after food"}'
```

Patients and doctors see only consultations within their care relationship. Admin lifecycle, payment, analytics, and audit endpoints require both the admin role and MFA.
Administrators are intentionally excluded from clinical consultation routes; a production break-glass workflow is a separate, unimplemented control.

## Idempotency and concurrency

`POST /v1/bookings`, `POST /v1/doctors/me/availability`, and prescription creation persist a key scoped to user and route, a canonical request hash, and the completed response for 24 hours. The idempotency record and domain mutation share one database transaction. A PostgreSQL `INSERT ... ON CONFLICT` claim serializes same-key contenders; a different payload is rejected, and an expired key can be reclaimed atomically. A cleanup job for old rows is still a production operations task.

Booking does not depend on a Redis lock. It atomically changes only a slot still in `AVAILABLE` state at the expected version. Database constraints independently reject overlapping doctor slots and more than one active consultation per slot.

## Security model

- Passwords use Argon2id; refresh tokens are random, stored only as SHA-256 digests, and rotated on use. Detected reuse revokes every active refresh token for that user.
- TOTP seeds, phone numbers, doctor licence numbers, consultation reasons/notes, and prescriptions use versioned AES-256-GCM field encryption. Multiple decrypt-only keys can remain configured during rotation.
- DTO allowlists reject unknown input. Authorization is enforced both by route guards and scoped service queries. Pino redacts authorization headers, passwords, refresh tokens, and MFA values.
- Audit rows are database-enforced append-only. They contain identifiers and event metadata, not clinical payloads or credentials.
- Production TLS, a cloud KMS/HSM, managed secret injection, external immutable audit storage, legal retention rules, and tested backup/key-rotation procedures remain deployment gates; they are not falsely claimed by the local stack.

See [Security and Threat Model](docs/security.md) for the attack surface, STRIDE analysis, OWASP API Top 10 controls, data classification, rotation runbook, and readiness checklist.

## Tests and CI

Unit tests exercise encryption/tamper detection, guards, authentication controls, idempotency, state transitions, and booking races. Against migrated PostgreSQL/Redis, the e2e suite verifies operations endpoints and runs the secured doctor registration/MFA/approval, availability/replay, search, patient booking/replay, BOLA denial, consultation transition, prescription/replay, and authorized decrypted-read workflow. CI performs formatting, linting, type checking, coverage, e2e tests, OpenAPI drift detection, a production build, `npm audit`, and HIGH/CRITICAL Trivy scans of the runtime and migration images. Releases must first pass that reusable CI workflow; they publish SBOM/provenance-attested images and render digest-pinned manifests before an optional deploy through the configured GitHub `production` environment.

The load scenario at [`tests/load/booking.js`](tests/load/booking.js) is designed for k6 and checks the assignment's read p95 below 200 ms and write p95 below 500 ms targets. These are validation objectives, not an unsupported claim about an arbitrary laptop.

## Architecture and operations

- [Architecture](docs/architecture.md) - topology and data flow, booking sequence, ER diagram, API shape, capacity, partitioning, caching, transactions/sagas, retries, SLOs, and DR.
- [Assumptions](docs/assumptions.md) - explicit decisions where the brief is silent.
- [Security and Threat Model](docs/security.md) - controls and production readiness gates.
- [ADR 001](docs/adr/001-modular-monolith.md) - why a modular monolith is the initial deployment unit.
- [Five-minute Demo](docs/demo-script.md) - timed reviewer walkthrough.
- [`infra/k8s`](infra/k8s) - API/worker deployments, service, ingress, HPA, PDB, network policy, configuration, and secret example.
- [`infra/observability`](infra/observability) - Prometheus, alerts, Grafana provisioning/dashboard, and OpenTelemetry Collector.

Capacity planning assumes a 10x peak-to-average traffic factor and validates with production-like data. API/worker replicas are stateless; PostgreSQL remains the authoritative consistency boundary. The documented production target is multi-zone service with 99.95% monthly availability, RPO at most 5 minutes, and RTO at most 60 minutes.

## Repository layout

```text
src/                 NestJS modules, shared controls, telemetry, and worker
prisma/              PostgreSQL schema, hand-reviewed migration, and admin seed
test/                Unit and PostgreSQL/Redis end-to-end tests
tests/load/           k6 load scenario
docs/                 Architecture, assumptions, security, ADR, and demo guide
infra/k8s/            Production-oriented Kubernetes reference manifests
infra/observability/  Collector, Prometheus, alert, and Grafana configuration
.github/workflows/    CI, dependency audit, image build, and vulnerability scan
```

## Scope boundaries

Video transport, chat, pharmacy fulfilment, insurance, tax/settlement, automated clinician-license verification, and medical decision support are intentionally outside this backend assignment. Payment records and status transitions are implemented, while a real payment provider remains an adapter boundary. Legal certification requires a deployment-specific clinical, privacy, and compliance review.
