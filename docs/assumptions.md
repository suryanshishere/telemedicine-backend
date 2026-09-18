# Assumptions and Design Decisions

This file records choices made where the assignment is intentionally open-ended. Items under **Assignment facts** are requirements; the remaining items are implementation assumptions that can be changed without misrepresenting the brief.

## Assignment facts

- The backend must cover authentication/roles, doctor availability and booking, consultations and prescriptions, search/filtering, compliance/audit trails, and admin analytics.
- PostgreSQL is required; Redis is optional. The API may be REST or GraphQL and the language may be Node.js, Go, or Python.
- Writes must be idempotent. Heavy work is asynchronous. Rate limiting, validation, environment-provided secrets, MFA, RBAC, encryption, metrics, logs, traces, containerized CI/CD, backup/DR, and threat modelling are required.
- Targets are 100,000 consultations/day, p95 below 200 ms for reads and 500 ms for writes, and 99.95% availability.
- The named core tables are `users`, `profiles`, `doctors`, `availability_slots`, `consultations`, `prescriptions`, `payments`, and `audit_logs`.

## Technology and topology

- Node.js/TypeScript with NestJS is used for its module boundaries, dependency injection, validation, and OpenAPI support.
- The initial production unit is a modular monolith, not a distributed microservice fleet. API and outbox-worker processes scale separately.
- PostgreSQL is the source of truth. Redis is used only for the 30-second doctor-search cache, 60-second aggregate admin-analytics cache, and fixed-window rate counters—not distributed locking, booking truth, or a job queue.
- Asynchronous delivery uses a PostgreSQL transactional outbox. Multiple workers poll with `FOR UPDATE SKIP LOCKED`, exponential backoff, and dead-letter semantics.
- REST with a `/v1` prefix is the public contract. UTC ISO-8601 timestamps, offset-style `page`/`limit` pagination, and a common Problem Details error envelope are used.
- Local development uses Docker Compose. The production reference assumes managed, multi-zone PostgreSQL/Redis and autoscaled containers; a specific cloud vendor is not required by the brief.

## Identity, roles, and security

- One account has one primary role: `PATIENT`, `DOCTOR`, or `ADMIN`. A doctor also has a `doctors` record. Clinical consultation routes admit only patients and doctors, then scope each query to the patient or assigned doctor. Administrators have no clinical-record route; a purpose-bound break-glass workflow is not implemented.
- Public doctor registration creates an `ACTIVE` user with an inactive doctor profile. The doctor can log in and enroll TOTP, but cannot publish availability until an MFA-authenticated administrator activates the doctor with `PATCH /v1/admin/doctors/{id}/activation`.
- Email is the login identifier. Passwords are hashed with Argon2id. HS256 access tokens default to 15 minutes and validate issuer/audience; opaque refresh tokens default to 30 days, are stored as SHA-256 digests, rotate on use, and cause all active refresh tokens for that user to be revoked on detected reuse.
- TOTP is available to patients and is required by guards for doctor clinical/availability actions and every admin route. Setup stores a pending encrypted secret and promotes it only after atomic code verification; the last accepted time step prevents replay. An MFA-verified user can replace their factor, but recovery codes and lost-factor/admin-assisted reset are not implemented.
- Sensitive fields use a versioned AES-256-GCM envelope string with a random nonce and key ID. Keys currently come from environment configuration and older configured keys remain decrypt-capable. TLS, managed storage encryption, KMS/HSM wrapping, authenticated context, and exercised re-encryption/rotation are deployment gates, not local-stack claims.
- The implementation demonstrates security controls but does not claim HIPAA, India DPDP Act, or any other certification. Deployment jurisdiction, consent text, retention, deletion, and breach processes require legal/product approval.

## Domain behavior

- Instants are persisted as UTC `timestamptz`; `dateOfBirth` is a date. No profile timezone is stored, so clients are responsible for localized display. Slot boundaries are `[startsAt, endsAt)`, allowing adjacent slots without overlap.
- Only an active doctor may publish their own future availability; there is no admin create-on-behalf route. PostgreSQL prevents overlapping `AVAILABLE` or `BOOKED` slots.
- A patient may book an `AVAILABLE` future slot. An atomic update conditioned on the slot's current version and status decides races; a partial unique consultation index is the backstop. Redis is never consulted for correctness.
- Availability states are `AVAILABLE`, `BOOKED`, and `BLOCKED`. Consultation states are `SCHEDULED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`, and `NO_SHOW`. Patients may cancel their own future scheduled consultation; assigned MFA-authenticated doctors may apply only the explicit transition matrix. Administrators cannot read or transition consultations.
- Only the assigned MFA-authenticated doctor may issue a prescription while the consultation is `IN_PROGRESS` or `COMPLETED`. The schema permits exactly one immutable prescription per consultation; amendment/version history is not implemented.
- Doctor search covers display name/specialization, fee bounds, and an optional `availableFrom`, using offset pagination. Admin analytics returns bounded-date consultation totals/status/daily counts, completion/cancellation rates, captured-payment revenue, and active doctor/patient counts; it does not return booking-conflict, latency, or availability telemetry.
- Payments use `PENDING`, `AUTHORIZED`, `CAPTURED`, `REFUNDED`, and `FAILED`, with an explicit transition matrix. Booking creates a `PENDING` record; an admin MFA route updates status. A real provider, pricing/tax/settlement, and webhook verification remain adapter work.

## Idempotency and consistency

- Booking, availability creation, and prescription creation require an 8-100-character URL-safe `Idempotency-Key`. Keys are scoped to authenticated user and route and bound to a canonical request hash.
- Same key and payload replays a completed stored status/body. Reusing a key with another payload returns 409; a concurrent duplicate still marked `PROCESSING` also returns 409 rather than waiting.
- The guarantee is logical at-most-once mutation within the retention window, not magical exactly-once networking. Outbox delivery is at least once, so consumers deduplicate by event ID.
- Idempotency rows receive an `expiresAt` 24 hours in the future. The claim query atomically replaces an expired row, making its key reusable; no physical cleanup/archive job exists, so table-retention management remains production work.
- Consultation updates carry `expectedVersion` in the JSON body and return 409 on a stale update; `If-Match` is not implemented. Booking uses an atomic expected-version update rather than a pessimistic row lock.
- State-changing `PATCH` routes use compare-and-set or explicit same-state behavior rather than create-style keys. Payment retries with the same state/reference return the current row; another reference or a stale concurrent transition returns 409.
- Notifications and analytics cannot invalidate a committed booking. If a future payment step is made mandatory, it becomes a saga with explicit compensation.

## Performance and SLO interpretation

- The capacity plan assumes a 10x peak-to-average ratio and about 20 API interactions per consultation, producing a planning estimate of roughly 230 requests/s at peak. The checked-in k6 scenario is configurable and enforces the latency thresholds, but no throughput or latency result is claimed until a dated run from a production-like environment is attached.
- Latency is measured at the API from request acceptance through response serialization; write latency includes database commit but excludes asynchronous notification delivery. Successful requests are used for the stated p95, while errors are tracked separately.
- Availability is measured monthly for eligible API traffic. The 99.95% objective gives about 21.6 minutes of monthly error budget. No exclusion for planned maintenance is assumed.
- SLOs are targets to validate under a declared load-test environment, not claims that a laptop Compose stack itself provides multi-zone availability.

## Data lifecycle and recovery

- `audit_logs` is append-only through a database trigger and has time/resource indexes, but it is not partitioned. Monthly range partitioning is a future scale option; retention remains pending legal approval.
- Idempotency rows have enforced 24-hour key-reuse semantics, and outbox rows track published/dead-letter state, but no cleanup/archive job is implemented for either table.
- RPO <= 5 minutes, RTO <= 60 minutes, point-in-time recovery, 35-day backup retention, a cross-region copy, monthly restore tests, and quarterly failover exercises are production targets. The repository does not provision or demonstrate those managed-database operations.
- Clinical-data retention and patient deletion/anonymization rules are deliberately not invented. They must be set by the product owner and counsel for the operating jurisdiction.

## Explicit non-goals for this assignment

- Video/media transport, chat, pharmacy fulfillment, insurance, payment-provider settlement, clinician licensing verification, and medical decision support.
- Multi-region active/active writes, event-streaming infrastructure, or premature service decomposition.
- A claim of legal certification or a substitute for a clinical safety, privacy, and compliance review.
