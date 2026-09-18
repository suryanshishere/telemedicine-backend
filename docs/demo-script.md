# Five-Minute Demo Script

This script demonstrates the evaluation-critical path in five minutes. The seed command creates only the administrator. Before recording, follow the README to register a patient and doctor, enroll MFA for the doctor/admin, activate the doctor, create one future availability slot, and capture the resulting IDs/tokens. Keep a second terminal open for logs and metrics.

```bash
export API=http://localhost:3000
export PATIENT_EMAIL=patient@example.test
export PATIENT_PASSWORD='<password chosen when the patient was registered>'
```

## 0:00-0:30 — Scope and startup

**Say:** “This is a NestJS modular monolith backed by PostgreSQL. Redis accelerates reads and rate limiting, while committed asynchronous work uses a transactional PostgreSQL outbox. The database—not Redis—prevents double booking.”

Show the README, OpenAPI page, and architecture diagrams. If the stack is not already running:

```bash
docker compose up -d --build
curl -s "$API/health/live"
curl -s "$API/health/ready"
```

Point out that liveness checks only the process. Readiness requires PostgreSQL; it reports Redis in its checks and returns HTTP 200 with `status: "degraded"` when Redis is unavailable because cache misses and the bounded in-process rate limiter are safe fallbacks.

## 0:30-1:10 — Authentication, MFA, and RBAC

Login with the prepared patient and show the short-lived access/refresh-token response (do not expose a real secret). Briefly show the TOTP setup/verification route for the doctor or admin. Setup keeps a pending encrypted seed until verification and accepted TOTP steps are consumed atomically to prevent replay; recovery codes are not implemented.

```bash
curl -s -X POST "$API/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$PATIENT_EMAIL\",\"password\":\"$PATIENT_PASSWORD\"}"

curl -i "$API/v1/admin/analytics" \
  -H "Authorization: Bearer $PATIENT_TOKEN"
```

**Expected:** login succeeds; the patient receives `403` on the admin route. Mention Argon2id password hashing, rotating refresh tokens, role guards, validation, rate limiting, and audit events for sensitive actions.

## 1:10-1:50 — Doctor search and availability

```bash
curl -s "$API/v1/doctors?specialization=Ayurveda&page=1&limit=10"

curl -s "$API/v1/doctors/$DOCTOR_ID/availability?from=2026-09-20T00:00:00Z&to=2026-09-27T00:00:00Z"
```

Show public filtering and offset pagination (`page`, `limit`, `total`). Doctor-search responses are cached for 30 seconds; the availability endpoint and booking path read PostgreSQL. Note UTC timestamps and the database exclusion constraint that prevents overlapping `AVAILABLE` or `BOOKED` slots.

## 1:50-2:55 — Idempotent, concurrency-safe booking

Book once, then repeat the exact request with the same key:

```bash
export IDEM=demo-booking-001
curl -i -X POST "$API/v1/bookings" \
  -H "Authorization: Bearer $PATIENT_TOKEN" \
  -H "Idempotency-Key: $IDEM" \
  -H 'Content-Type: application/json' \
  -d "{\"slotId\":\"$SLOT_ID\",\"reason\":\"Recurring migraine consultation\"}"

curl -i -X POST "$API/v1/bookings" \
  -H "Authorization: Bearer $PATIENT_TOKEN" \
  -H "Idempotency-Key: $IDEM" \
  -H 'Content-Type: application/json' \
  -d "{\"slotId\":\"$SLOT_ID\",\"reason\":\"Recurring migraine consultation\"}"
```

**Expected:** the retry returns the same consultation/result with `Idempotency-Replayed: true` and creates no duplicate. If time permits, race two different keys against a fresh slot; exactly one succeeds and the other returns `409` with `Slot is no longer available` in the Problem Details body.

**Say:** “One transaction atomically updates the slot only if it is still `AVAILABLE` at the version read, then inserts the `SCHEDULED` consultation, `PENDING` payment, audit row, idempotency response, and outbox event. A partial unique index is the final backstop. Workers claim events with `FOR UPDATE SKIP LOCKED`, recover expired leases, retry with capped exponential backoff and jitter, and dead-letter the default eighth failure.”

## 2:55-3:40 — Consultation and prescription lifecycle

As the assigned doctor, advance the consultation and issue a prescription:

```bash
curl -s -X PATCH "$API/v1/consultations/$CONSULTATION_ID/status" \
  -H "Authorization: Bearer $DOCTOR_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"status":"IN_PROGRESS","expectedVersion":1,"clinicalNotes":"Assessment recorded securely"}'

curl -s -X POST "$API/v1/consultations/$CONSULTATION_ID/prescriptions" \
  -H "Authorization: Bearer $DOCTOR_TOKEN" \
  -H 'Idempotency-Key: demo-rx-001' \
  -H 'Content-Type: application/json' \
  -d '{"medications":[{"name":"Demo medicine","dosage":"1 tablet","frequency":"once daily","duration":"3 days"}],"instructions":"Take after food"}'
```

Show that an unrelated doctor/patient cannot mutate the consultation. Mention the explicit state-transition matrix, `expectedVersion` concurrency check, one immutable prescription per consultation, AES-256-GCM field encryption, and redaction of credential/MFA fields from logs. Amendment/version history is not implemented.

## 3:40-4:20 — Audit, analytics, and observability

```bash
curl -s "$API/v1/admin/audit-logs?resourceType=consultation&page=1&limit=20" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

curl -s "$API/v1/admin/analytics?from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

curl -s "$API/metrics" | grep -E 'amrutam_(http|process|nodejs|outbox)_'
```

Show JSON logs correlated by `x-request-id` and one trace if the local collector is enabled. The Prometheus surface includes HTTP request count/duration, default Node.js/process metrics, and `amrutam_outbox_events{status}` counts. Show the Grafana pending/dead-letter panels or the corresponding checked-in alerts. Booking conflicts, cache hits, database-pool wait, oldest-outbox age/retry rate, worker throughput, and security-denial metrics remain follow-up work.

## 4:20-4:50 — Tests, CI, and infrastructure

```bash
npm test
RUN_E2E=true npm run test:e2e
```

The e2e suite requires reachable PostgreSQL/Redis and the documented environment variables; without `RUN_E2E=true` it is intentionally skipped. In addition to readiness/OpenAPI/authentication checks, it runs doctor MFA and approval, idempotent availability and booking, participant/admin access denial, consultation transitions, idempotent prescription issue, and the patient's decrypted clinical read. Show CI's formatting, lint, type-check, unit coverage, real migration/e2e run, OpenAPI drift check, build, dependency audit, and runtime/migration image scans. Release invokes that reusable CI workflow before publishing SBOM/provenance-attested images, scans the published digests, renders digest-pinned manifests, and optionally deploys through the GitHub `production` environment. Show the non-root/read-only runtime and Kubernetes reference. Managed secret injection, multi-zone databases, PostgreSQL PITR, the RPO <= 5 minute/RTO <= 60 minute targets, and restore drills are production gates, not capabilities demonstrated by Compose.

## 4:50-5:00 — Close

**Say:** “The implemented critical path combines RBAC and MFA guards, database constraints plus an atomic versioned slot claim, persisted idempotency, encrypted clinical fields, append-only audit rows, and a durable outbox. HTTP/runtime/outbox metrics, structured logs, and traces provide the current observability baseline; the docs label remaining production gates explicitly.”

If a command fails during the recording, keep the response with its `requestId`, show the matching log entry, and explain the diagnosed cause; do not hide a failing path with pre-recorded output.
