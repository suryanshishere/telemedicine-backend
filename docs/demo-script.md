# Five-Minute Submission Demo Script

Use this as the exact recording script. Keep the GitHub repository, the successful CI run, Swagger UI, and one terminal visible. Prepare patient, doctor, and administrator tokens plus one future availability slot before recording. Never show passwords, MFA secrets, or encryption keys.

## 0:00-0:35 - Introduction and technology stack

**Say:**

"This is my completed backend submission for a production-oriented telemedicine platform. It is a TypeScript and NestJS modular monolith using PostgreSQL with Prisma for durable data, Redis for caching and distributed rate limiting, and REST APIs documented with OpenAPI. Security uses JWT access tokens, rotating refresh tokens, Argon2id password hashing, TOTP multi-factor authentication, role-based authorization, and AES-256-GCM encryption for clinical data. The project also includes Docker, Kubernetes manifests, GitHub Actions, Prometheus, Grafana, OpenTelemetry, and a PostgreSQL transactional outbox."

**Show:** `README.md`, the architecture diagram in `docs/architecture.md`, and the Swagger page at `/docs`.

**Proof:** The checked-in OpenAPI contract contains 25 operations across 24 paths.

## 0:35-1:15 - Authentication, MFA, and authorization

**Say:**

"Patients and doctors can register and log in. Doctors remain inactive until approved by an administrator. Doctor and administrator privileged actions require verified TOTP MFA. Refresh tokens are hashed, rotated, and can be revoked. Guards enforce patient, doctor, and administrator permissions, while validation, rate limiting, secure headers, and Problem Details provide a consistent security boundary."

**Show:** Log in as a patient, then call `GET /v1/admin/analytics` with the patient token.

**Expected proof:** Login succeeds, while the admin endpoint returns `403 Forbidden`. Show the doctor MFA setup and verification endpoints in Swagger, without revealing the TOTP secret.

## 1:15-2:10 - Doctor discovery, availability, and safe booking

**Say:**

"Patients can search approved doctors by specialization with pagination and view future availability. Doctors create availability in UTC. PostgreSQL exclusion constraints reject overlapping active slots. Booking is safe under concurrency: one transaction conditionally claims an available versioned slot, creates the scheduled consultation and pending payment, writes the audit record, stores the idempotent response, and adds an outbox event. A partial unique database index is the final double-booking backstop."

**Show:** Search doctors, open a doctor's availability, then book a slot using an `Idempotency-Key`. Repeat the identical booking request with the same key.

```bash
curl -i -X POST "$API/v1/bookings" \
  -H "Authorization: Bearer $PATIENT_TOKEN" \
  -H "Idempotency-Key: demo-booking-001" \
  -H "Content-Type: application/json" \
  -d "{\"slotId\":\"$SLOT_ID\",\"reason\":\"Recurring migraine\"}"
```

**Expected proof:** The retry returns the original result with `Idempotency-Replayed: true`; it does not create a second consultation. A competing request for the same slot receives `409 Conflict`.

## 2:10-2:55 - Consultation, prescription, payment, and privacy

**Say:**

"Only the assigned doctor and patient can access a consultation. The doctor advances it through an explicit state-transition workflow using `expectedVersion` for optimistic concurrency. The assigned doctor can issue one immutable prescription, and the patient can read the decrypted clinical result. Sensitive clinical fields are encrypted with authenticated AES-256-GCM encryption. Payment records are created as pending and updated through protected, idempotent webhook handling. All sensitive actions create append-only audit entries."

**Show:** Move a consultation from `SCHEDULED` to `IN_PROGRESS`, issue a prescription, and retrieve it as the participating patient. Then attempt access using an unrelated user.

**Expected proof:** Valid participants succeed; an unrelated patient or doctor receives `404`, preventing resource enumeration, and an unauthorized role receives `403`.

## 2:55-3:35 - Reliability and scalability

**Say:**

"Committed background work is never dependent on Redis. The transactional outbox stores work in PostgreSQL in the same transaction as the business change. Workers claim events with `FOR UPDATE SKIP LOCKED`, recover expired leases, retry with exponential backoff and jitter, and dead-letter repeated failures. Redis accelerates doctor search and rate limiting, but safe local fallbacks keep the API functional when Redis is unavailable. Database indexes cover the main search and ownership paths. Kubernetes includes separate API and worker deployments, health probes, autoscaling, disruption budgets, non-root containers, and read-only filesystems."

**Show:** `src/modules/outbox`, `infra/k8s`, and the health responses.

**Expected proof:** `/health/live` confirms the process is alive; `/health/ready` requires PostgreSQL and reports Redis degradation explicitly.

## 3:35-4:15 - Observability and administration

**Say:**

"Every request has a correlation ID and structured logs. OpenTelemetry provides traces. Prometheus exposes HTTP latency and request counts, Node.js and process metrics, plus outbox status metrics. Grafana dashboards and Prometheus alerts cover API health and pending or dead-lettered events. Administrators have paginated audit-log search and date-filtered operational analytics."

**Show:** `/metrics`, one correlated request log, the Grafana dashboard definition, `GET /v1/admin/audit-logs`, and `GET /v1/admin/analytics`.

## 4:15-4:50 - Automated proof

**Say:**

"The repository is continuously verified rather than relying only on this demo. The successful GitHub Actions run performs formatting, linting, type checking, Prisma validation and migrations, deterministic OpenAPI generation, 85 unit tests with enforced coverage thresholds, and a complete PostgreSQL and Redis end-to-end workflow. It also builds the production application and both Docker images, runs the dependency audit, and passes high-and-critical Trivy vulnerability scans."

**Show:**

- Repository: <https://github.com/suryanshishere/telemedicine-backend>
- Successful CI proof: <https://github.com/suryanshishere/telemedicine-backend/actions/runs/35424501818>
- Test result: 85 unit tests passed, plus the full integration workflow.
- Coverage: 54.93% statements, 58.04% branches, 44.30% functions, and 55.59% lines.

## 4:50-5:00 - Closing confirmation

**Say:**

"This completes the requested submission end to end: runnable source code, database schema and migrations, documented APIs, secure authentication and authorization, concurrency-safe booking, consultation and prescription workflows, payment integration, audit and analytics, background processing, caching, observability, automated tests, CI security checks, containerization, Kubernetes infrastructure, architecture and security documentation, and this five-minute proof walkthrough."
