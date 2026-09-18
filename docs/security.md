# Security and Threat Model

Status: reconciled implementation baseline plus explicit production gates  
Last reviewed: 2026-09-19  
System: Amrutam telemedicine backend

## 1. Purpose and scope

This document defines the security posture for the backend API, PostgreSQL outbox workers, Redis, observability pipeline, deployment platform, backups, and external integrations. It covers authentication, authorization, booking, consultations, prescriptions, search, administration, payments metadata, and audit trails.

The implemented architecture is a NestJS/TypeScript modular monolith using Prisma and PostgreSQL, Redis only for bounded doctor-search/admin-analytics caches and fixed-window rate limits, HS256 JWT access tokens with rotating opaque refresh tokens, TOTP MFA, Argon2id password hashing, role-based access control (RBAC), versioned AES-256-GCM field encryption for protected health information (PHI), persisted idempotency records, and a PostgreSQL transactional outbox.

This is a threat model, not a compliance certification. Before production, the product owner and qualified counsel must determine the jurisdictions, clinical-record obligations, breach-notification rules, data-residency constraints, and whether frameworks such as India's DPDP Act or HIPAA apply.

## 2. Security objectives and current status

Implemented controls:

1. Patient consultation queries are scoped to the authenticated patient; doctor queries are scoped to consultations assigned to that doctor's profile.
2. DTO allowlisting rejects unknown properties, service methods derive actor/ownership data server-side, and route/service checks enforce patient and doctor actions.
3. Opaque refresh tokens are stored as SHA-256 digests, rotate atomically on use, and produce an audit event plus revocation of all active refresh tokens for the user on detected reuse. There is no separate token-family identifier.
4. TOTP setup stores a pending encrypted secret and promotes it only after verification. Login and setup verification atomically consume the accepted time step to reject replay.
5. MFA assurance protects doctor availability, consultation-transition, and prescription operations plus all admin controllers; doctor/admin enrollment is operationally required before those routes work.
6. Concurrent booking uses an atomic `AVAILABLE` plus expected-version update and a partial unique consultation index. Idempotency protects booking, availability creation, and prescription creation.
7. The schema permits one immutable, attributable prescription per consultation. Amendment/version history is not implemented.
8. Selected fields use versioned AES-256-GCM with a fresh nonce. Current keys are supplied through environment configuration, not a KMS/HSM envelope-key service.
9. Business mutations write audit rows in their PostgreSQL transaction, consultation-detail reads emit `consultation.viewed`, and a database trigger rejects audit updates/deletes. List reads and failed authorization attempts are not comprehensively audited, and there is no external immutable/tamper-evident sink.
10. Pino redacts configured credential, refresh-token, cookie, and MFA paths. Redis and outbox payloads contain identifiers/minimum event metadata rather than clinical text.
11. No card number, CVV, bank credential, or raw payment-provider secret is stored by this service.

Production invariants still requiring implementation or deployment evidence are a purpose-bound break-glass path if administrators need emergency clinical access, password recovery and lost-factor MFA recovery/reset, managed TLS/storage encryption, KMS/HSM key custody and rotation, comprehensive read/security-event auditing, immutable external audit storage, retention/deletion workflows, backup/restore proof, and additional domain-specific security/worker metrics.

## 3. System context and trust boundaries

```text
Untrusted clients
  -> TLS edge / ingress / load balancer
  -> NestJS API process
       -> PostgreSQL (system of record)
       -> Redis (rate limits and bounded cache only)
       -> PostgreSQL outbox worker(s)
       -> notification/payment providers (when configured)
       -> OpenTelemetry collector / metrics / log sink

CI/CD control plane
  -> image registry
  -> Kubernetes or container runtime
  -> API and worker workloads

Backup operator / managed service (production target)
  <- encrypted PostgreSQL backups and recovery logs
```

Trust boundaries exist between clients and the edge, edge and application, application and each datastore, producer and worker, application and third parties, runtime and observability backends, CI and the image registry, and operators and production. Authentication at one boundary does not imply authorization at another.

### Primary assets

- Account identity, contact details, password hashes, MFA seeds, refresh-token records, and future recovery credentials.
- Doctor credentials, schedules, and availability.
- Consultation details, clinical notes, prescriptions, and care relationships.
- Booking integrity and status-transition history.
- Payment references and status, excluding raw card data.
- Encryption/signing keys, provider credentials, database credentials, and deployment secrets.
- Audit evidence, logs, traces, metrics, backups, and restore credentials.
- Service availability and the integrity of administrative analytics.

### Threat actors

- Unauthenticated internet attackers and automated scanners.
- Credential-stuffing attackers using breached credentials.
- Authenticated patients attempting horizontal privilege escalation.
- Doctors attempting to access patients outside their care relationship.
- Malicious or compromised administrators and operators.
- Compromised dependencies, CI credentials, images, or third-party providers.
- Accidental insiders causing disclosure through logs, exports, support tools, or misconfiguration.

## 4. Attack surface

| Surface                                 | Principal risks                                                                             | Implemented baseline and remaining controls                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public REST API                         | Injection, schema abuse, broken authorization, enumeration, resource exhaustion             | Strict DTO validation, unknown-field rejection, parameterized Prisma queries, centralized auth guards, service-level object authorization, pagination limits, timeouts, rate limits                                                                                                                                                                             |
| Login, refresh, and MFA                 | Credential stuffing, account enumeration, token theft, refresh replay, TOTP replay          | Argon2id, generic login errors, route/IP throttles, opaque SHA-256-digested refresh tokens, atomic rotation, per-user revocation on reuse, pending TOTP secret, and atomic time-step consumption are implemented; password/MFA recovery is not                                                                                                                  |
| Booking endpoints                       | Double booking, forged ownership, replay, state-machine bypass                              | Database transaction, unique/exclusion constraint, row/version conflict handling, idempotency key bound to actor/route/body hash, explicit state transitions                                                                                                                                                                                                    |
| Consultation and prescription endpoints | BOLA, unauthorized edits, mass assignment, medico-legal repudiation                         | Participant-scoped queries, allowlisted fields, expected-version status updates, one immutable prescription, transaction audit, and MFA-gated doctor writes are implemented; amendment/revocation workflow is not                                                                                                                                               |
| Search and filtering                    | Record enumeration, wildcard amplification, injection, side-channel leakage                 | Public doctor results include only approved fields; consultation scope is applied before bounded filters; pages and date ranges are capped. Query-cost budgets and database statement timeouts remain deployment gates                                                                                                                                          |
| Admin and analytics endpoints           | Privilege escalation, bulk exfiltration, sensitive exports                                  | Admin role plus MFA and aggregate analytics are implemented. Admins are excluded from clinical routes; a purpose-bound break-glass path, export controls, and separate auditor/support roles are not implemented                                                                                                                                                |
| API documentation, health, metrics      | Endpoint discovery, config or credential disclosure                                         | Liveness is minimal. Health and metrics are public in the app; the Kubernetes ingress exposes only `/v1` and the network policy admits monitoring/probe paths. Production routing must preserve that isolation                                                                                                                                                  |
| PostgreSQL and Prisma                   | SQL injection, broad service privileges, backup leakage, destructive migrations             | Prisma and parameterized `Prisma.sql`, constraints, and reviewed migration are implemented; separate runtime/migration roles, DB TLS, managed encrypted backups, and tested PITR are deployment gates                                                                                                                                                           |
| Redis                                   | Cache poisoning, rate-limit bypass, sensitive-cache leakage, memory exhaustion              | Doctor search (30 seconds), aggregate admin analytics (60 seconds), and rate counters use Redis. Cache-miss and bounded in-process limiter fallbacks are implemented; production TLS/auth/ACLs and memory policy depend on the managed deployment                                                                                                               |
| PostgreSQL outbox worker                | Duplicate side effects, poison events, confused deputy, unsafe retries or concurrent claims | Transactional insertion, `FOR UPDATE SKIP LOCKED`, five-minute lease recovery, bounded attempts/backoff, and dead-letter state are implemented. The handler currently logs dispatch; provider idempotency and replay authorization are future adapter controls                                                                                                  |
| Webhooks and outbound APIs              | Forged callbacks, SSRF, dependency compromise, data over-sharing                            | No provider/webhook adapter is implemented. Signature/timestamp validation, replay protection, destination allowlists, egress policy, TLS verification, and response schemas are required before adding one                                                                                                                                                     |
| Logs, traces, metrics, error reporting  | PHI/token leakage, excessive access, long retention                                         | Pino path redaction, request IDs, HTTP/runtime and outbox-status metrics, and optional OpenTelemetry export exist; telemetry allowlists/redaction tests, retention/access policy, and additional domain/security metrics remain gates                                                                                                                           |
| Containers and Kubernetes               | Secret exposure, vulnerable image, lateral movement, privilege abuse                        | Non-root/read-only runtime, dropped capabilities, resource limits, NetworkPolicy, and image scanning are present. The release build requests SBOM/provenance attestations; image signing and an external secret store are not implemented                                                                                                                       |
| CI/CD and source control                | Secret commits, dependency substitution, workflow compromise                                | Exact install, format/lint/type/unit/e2e/build checks, OpenAPI drift detection, npm audit, and Trivy scans are present. Release must pass reusable CI, scans published images by digest, renders digest-pinned manifests, and targets a named production environment; secret scan, SAST, signing, and evidence of configured environment approvals remain gates |
| Backups and operator access             | Bulk disclosure, unrecoverable loss, unlogged access                                        | RPO/RTO and restore cadence are documented targets only; managed encrypted/immutable backups, separate roles, access logs, and restore evidence must be supplied by the deployment                                                                                                                                                                              |

## 5. STRIDE threat analysis

Risk labels are qualitative. "Residual" assumes every listed mitigation is implemented and verified.

| STRIDE                 | Threat scenario                                                             | Impact   | Mitigations (implemented or gate)                                                                                                                                                                                                                           | Residual |
| ---------------------- | --------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Spoofing               | Credential stuffing takes over a patient or doctor account                  | High     | Implemented: Argon2id, generic errors, route/IP throttling, MFA on sensitive doctor/admin routes. Gates: breached-password screening, risk alerts, enforced enrollment policy                                                                               | Medium   |
| Spoofing               | A stolen refresh token is replayed                                          | High     | Implemented: SHA-256 digest at rest, atomic rotation, reuse detection, all-active-token revocation for the user, audit context. Gate: keyed digest/pepper and explicit session families                                                                     | Low      |
| Spoofing               | A forged JWT changes issuer, audience, role, or algorithm                   | Critical | Implemented: HS256 pinning plus signature, issuer, audience, and expiry validation and 15-minute default TTL. Gate: independently rotatable signing keys/key IDs                                                                                            | Low      |
| Spoofing               | A forged or replayed provider webhook changes payment/notification state    | High     | Future adapter gate: provider signature/timestamp checks, constant-time comparison, replay store, stable provider event ID, and state-machine validation                                                                                                    | Low      |
| Tampering              | Client uses mass assignment to change role, doctor, user, price, or status  | Critical | DTO allowlists, `whitelist` plus reject unknown fields, server-derived ownership and role, explicit Prisma select/update objects                                                                                                                            | Low      |
| Tampering              | Concurrent requests double-book a slot                                      | High     | PostgreSQL uniqueness/exclusion constraint as final authority, transaction, atomic expected-version slot claim, and persisted idempotency record                                                                                                            | Low      |
| Tampering              | A doctor silently replaces an issued prescription                           | High     | Implemented: one immutable prescription row per consultation plus actor audit. Gate: explicit amendment/revocation versions with reason capture                                                                                                             | Low      |
| Tampering              | An outbox event is changed, concurrently claimed, or delivered twice        | High     | Implemented: database-backed outbox, stable event ID, `FOR UPDATE SKIP LOCKED`, explicit claim/status transitions, and minimal payload. Gates: versioned event schemas and idempotency at each real provider adapter                                        | Low      |
| Repudiation            | User denies booking cancellation, prescription issue, or role change        | High     | Implemented: UTC timestamp, actor/action/resource/request ID, metadata, and DB trigger blocking changes. Gates: outcome/trace fields, external immutable sink, clock evidence, restricted auditor role                                                      | Low      |
| Repudiation            | Privileged operator changes config or accesses production directly          | High     | Production gates: named identities, MFA, just-in-time privilege, Kubernetes/cloud audit logs, break-glass reason and alert, and no shared accounts                                                                                                          | Medium   |
| Information disclosure | A user changes an object ID to read another patient's data (BOLA)           | Critical | Implemented consultation queries scope patient/doctor access and profile access derives the user ID from the token. A complete negative authorization matrix remains a gate; opaque IDs are defense in depth only                                           | Low      |
| Information disclosure | PHI appears in logs, traces, Redis, outbox events, or error messages        | Critical | Implemented: credential/MFA path redaction, no configured request/response-body logging, public/aggregate cache data, minimum-data outbox payloads, and normalized errors. Telemetry allowlists and automated PHI-leak tests remain gates                   | Medium   |
| Information disclosure | Database, snapshot, or backup is copied                                     | Critical | Implemented: AES-256-GCM on selected fields. Deployment gates: DB TLS/storage encryption, KMS/HSM key custody, isolated backup role, access audit, and restore controls                                                                                     | Medium   |
| Denial of service      | Login, search, availability, or analytics endpoints exhaust CPU/DB          | High     | Implemented: fixed-window route limits with bounded fallback, pagination/range caps, selected indexes, short caches, ingress timeouts, and an API HPA reference. Gates: application query timeouts, concurrency/cost budgets, and provider circuit breakers | Medium   |
| Denial of service      | Outbox flooding or poison events starve critical work                       | High     | Implemented: batch cap, bounded attempts, capped exponential backoff with jitter, lease recovery, dead-letter state. Gates: event quotas/priorities and age/backlog metrics/alerts                                                                          | Medium   |
| Elevation of privilege | Patient calls doctor/admin function or doctor accesses unrelated patient    | Critical | Deny-by-default policy, route guard plus domain authorization, scoped database queries, role-transition controls, authorization matrix tests                                                                                                                | Low      |
| Elevation of privilege | Compromised worker/service account reaches unnecessary data or cluster APIs | High     | Implemented: no mounted Kubernetes API token, NetworkPolicy reference, scoped containers. Gates: distinct API/worker identities, minimal database grants, and external secret scoping                                                                       | Medium   |

### High-priority abuse cases

The required production security test plan (only a subset is automated today) must attempt to:

- Enumerate or mutate another user's booking, consultation, prescription, profile, and audit data.
- Book the same slot concurrently and replay the same request with both matching and different payloads.
- Reuse a rotated refresh token and a previously accepted TOTP code.
- Set privileged fields through JSON properties not present in the public schema.
- Skip consultation and prescription state transitions.
- Trigger unbounded search, pagination, export, outbox-event creation, or nested-filter work.
- Inject CR/LF and structured values into log fields or cause raw tokens/PHI to reach telemetry.
- Submit forged, stale, and duplicated webhook events.
- Reach internal URLs or cloud metadata through any caller-controlled URL.

## 6. Authentication and session controls

### Passwords

- Passwords are hashed with Argon2id using memory cost 19,456 KiB, time cost 2, and parallelism 1 on registration. Production hardware benchmarking and transparent rehash-on-login remain gates.
- Registration enforces 12-128 characters with upper, lower, number, and symbol requirements. Password-manager output and long passphrases within that limit are accepted.
- Pino redacts the configured password field. A password reset/change endpoint and reset-token lifecycle are not implemented.
- Login returns `Invalid credentials` for unknown, wrong-password, or non-active accounts and performs an expensive dummy Argon2id hash for an unknown email to reduce account-enumeration timing differences.

### Access tokens

- Access JWTs default to 15 minutes and are accepted only from the bearer header.
- The current implementation pins HS256 and validates signature, issuer `amrutam-api`, audience `amrutam-clients`, and expiry. It reloads the user on each request and rejects inactive/deleted users or tokens issued before `passwordChangedAt`.
- Claims are `sub`, email, role, MFA assurance, issued/expiry times, issuer, and audience. They contain no clinical data, but email is mutable personal data and should be removed from a future minimized token profile.
- `JWT_SECRET` is one environment-supplied symmetric secret with no key ID or overlap mechanism. Managed secret custody and rotation (accept old, sign new, then retire) are production gates.

### Refresh tokens

- Refresh tokens are 48 random bytes encoded as base64url. PostgreSQL stores a SHA-256 digest, expiry, revocation time, and replacement digest; there is no HMAC pepper, device/session metadata, or family ID.
- Refresh atomically revokes the presented record and creates a replacement. Presentation of an already-revoked record revokes every active refresh token for that user and emits `auth.refresh_reuse_detected`.
- Each refresh-token row records whether its issuing session completed MFA. Refresh preserves only that assurance; enabling MFA revokes older refresh tokens and returns a new MFA-bound pair, so a pre-MFA refresh token cannot gain an MFA claim later.
- The default absolute lifetime is 30 days. Suspending/deleting a user revokes active refresh tokens; password change and lost-factor/admin-assisted MFA reset flows do not yet exist.
- Refresh and logout currently accept the token in a JSON body. A browser deployment should move it to a `Secure`, `HttpOnly`, appropriately scoped `SameSite` cookie with CSRF protection, but that transport is not implemented by this API.

### MFA

- TOTP is available to all users. Doctor availability, consultation-transition, and prescription operations plus every admin controller require an access token with MFA assurance; doctor/admin login itself does not force enrollment, so operational activation must ensure enrollment.
- Setup generates a seed, stores it in `mfa_pending_secret_encrypted`, and returns the seed/OTP URI once to the authenticated caller. Verification atomically promotes that encrypted pending seed and consumes the current TOTP step.
- MFA-enabled login also atomically updates `mfa_last_used_step`; the same or an older accepted step is rejected. Setup/login routes are rate-limited by the global or route-specific fixed-window guard.
- An MFA-verified user can replace their own factor through setup/verification. Recovery codes, lost-factor/admin-assisted reset, step-up recency beyond the token's MFA claim, and recovery-channel verification are not implemented and remain production gates.

## 7. Authorization model

RBAC grants the coarse capability; domain policy grants access to a particular resource.

| Role            | Intended access                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Patient         | Own profile and consultations (including embedded prescription); create booking; cancel own `SCHEDULED` consultation; public doctor/availability directory |
| Doctor          | Own profile/availability; consultations and patient data explicitly assigned to that doctor; prescription actions allowed by consultation state            |
| Admin           | User/doctor/payment lifecycle, audit listing, and analytics after MFA; no consultation read or transition access                                           |
| Worker/service  | Poll and update PostgreSQL outbox rows; the reference handler logs dispatch and has no interactive identity                                                |
| Auditor/support | Not implemented; a distinct read-only/masked role is a production option                                                                                   |

Patient and doctor consultation queries apply caller scope before user filters, and services enforce ownership/assignment plus transition rules. The consultation controller excludes administrators; a future emergency-access workflow would need purpose, time limits, alerts, and review. Authorization failures use normalized Problem Details responses but are not individually written to the audit table; aggregate denial metrics/alerts are a planned control.

## 8. Input, output, and business-flow controls

- The global validation pipe transforms declared types, allowlists DTO fields, rejects unknown fields, and reports all validation errors. Explicit Unicode normalization/canonicalization is not implemented.
- DTOs cap pages at 100, availability ranges at 31 days, analytics ranges at 366 days, prescription medications at 30, and key text fields. The Kubernetes ingress reference caps bodies at 1 MiB; consistent header/URL/body limits in every deployment remain a gate.
- Prisma operations are parameterized. The few raw operations (idempotency insert, daily analytics, outbox claim) use tagged `Prisma.sql` parameters.
- Services use explicit selections/mappers on sensitive responses. A formal response-DTO allowlist test for every route remains a gate.
- Consultation and payment transitions use explicit matrices; booking uses `AVAILABLE -> BOOKED`; a prescription is a one-time create rather than a status machine.
- Idempotency binds the authenticated user, method-qualified route string, key, and canonical request hash. A different hash or an identical request still processing returns 409; a completed match replays its stored body/status in the same transaction model.
- Idempotency rows receive a 24-hour `expires_at`; the claim query atomically replaces an expired row, enforcing key reuse at that boundary. No physical cleanup/archive job exists, so storage retention remains production operations work.
- Booking uses a conditional `UPDATE` on slot ID, `AVAILABLE` status, and expected version, backed by database constraints. Redis is not a locking authority.
- Insert each outbox event in the same PostgreSQL transaction as the business mutation. Workers claim small due batches with `SELECT ... FOR UPDATE SKIP LOCKED`, record an explicit processing lease/status, then commit the claim before making a slow external call.
- The reference handler logs dispatch and marks success by event ID. Failure increments attempts and moves `available_at` using capped exponential backoff plus small jitter; the default eighth failure enters `DEAD_LETTER`. Authorized/audited replay tooling is not implemented.
- Delivery semantics are at least once. Future external handlers must be idempotent because a row lock cannot prevent repetition after a crash or ambiguous provider response.
- Provider timeouts, circuit breakers, retry classification, and a total retry budget are future adapter requirements.

## 9. Encryption and key management

### Current field encryption

- Phone, doctor license number, TOTP current/pending seeds, consultation reason/notes, medications, and prescription instructions use AES-256-GCM.
- Every encryption uses a random 96-bit nonce and stores `version.keyId.nonce.tag.ciphertext` as one base64url envelope string. Tests cover round-trip, nonce uniqueness, old-key decryption, malformed input, and tamper detection.
- The cipher currently sets no authenticated additional data binding a value to its table, row, or field. Adding stable AAD is a production hardening item and requires a backward-compatible envelope version.
- `FIELD_ENCRYPTION_KEYS` contains raw base64 keys in runtime environment configuration and `ACTIVE_FIELD_KEY_ID` selects the write key. This is a versioned key ring, not DEK/KEK envelope encryption and not KMS/HSM custody.
- The Kubernetes ingress reference terminates TLS, but the local API and Compose data paths use plain HTTP/PostgreSQL/Redis networking. Database/storage/snapshot/backup/log encryption is the responsibility of the production platform and is not demonstrated here.

### Key separation and rotation

Production must separate JWT signing, PHI field encryption, refresh-token digest pepper (if added), webhook verification, audit integrity, and backup encryption. The current configuration has distinct JWT and field-encryption secrets but no webhook/audit/backup keys in this application.

Rotation periods are operational starting points, not substitutes for a risk-based cryptoperiod:

| Key/secret                        | Planned rotation                                                  | Rotation behavior                                                                                                               |
| --------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| HS256 JWT secret                  | At most every 90 days and immediately on suspicion                | Rotation overlap is not implemented; add key IDs/multiple verification keys or revoke sessions during a coordinated rotation    |
| Field-encryption key              | At most annually or provider policy, and immediately on suspicion | Current key ring writes with the active ID and decrypts old IDs; add a resumable, audited re-encryption job and KMS/HSM custody |
| Refresh-token digest pepper       | At most every 180 days and on suspicion                           | Not currently present; version a future pepper or revoke affected sessions during introduction/rotation                         |
| Webhook/provider secret           | At most every 90-180 days and on provider incident                | Future integration: allow dual-secret verification during bounded overlap and test before retirement                            |
| Database/Redis/service credential | At most every 90 days and on role/personnel change                | Deployment runbook: create new credential, deploy, verify, revoke the old value, and audit each step                            |

On suspected compromise, stop use immediately, preserve evidence, rotate dependent credentials, revoke affected tokens, assess ciphertext exposure, and do not wait for the normal schedule. Managed least-privilege key access logs and restore access to historical key versions are production requirements; the local environment-backed key ring does not provide them.

## 10. Data classification and handling

| Class        | Examples                                                                                                                                                                       | Handling requirements                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public       | Published doctor directory fields, public API documentation intentionally exposed                                                                                              | Integrity controls; no confidential data in examples; cache permitted                                                                                                       |
| Internal     | Non-sensitive service topology, aggregate capacity metrics, runbooks without secrets                                                                                           | Workforce access only; do not publish; encrypt in transit and at rest                                                                                                       |
| Confidential | Email, phone, date of birth, address, doctor credential documents, internal analytics, payment-provider customer/reference IDs                                                 | Need-to-know RBAC, encryption, masked UI/logs, bounded exports and retention                                                                                                |
| Restricted   | Consultation reason/notes, prescriptions, TOTP seeds, refresh tokens, keys/secrets, raw audit evidence linking clinical access, and future clinical attachments/recovery codes | Field encryption where applicable, strict object authorization, no shared caches, no raw telemetry, audited access, minimal replication/export, approved retention/deletion |

Additional rules:

- Treat derived health inferences as Restricted even if they do not appear in a clinical table.
- Keep payment processing with a compliant provider. Store only provider IDs, status, amount/currency, and reconciliation metadata; never store PAN or CVV.
- Store the minimum data needed for the stated workflow. Optional fields are not collected "for future use."
- Production data must not be copied into development/test. Use synthetic fixtures or irreversibly anonymized datasets reviewed for re-identification risk.
- Exports inherit the highest classification present, are time-bounded, encrypted, access-controlled, and auditable.
- Current Redis cache keys encode public doctor-search query objects (30-second TTL) or the requested aggregate analytics range (60-second TTL); values contain public directory data or aggregates, not clinical records. Future user-scoped caches must bind subject/scope safely, avoid sensitive cleartext in keys, and define invalidation.

## 11. Audit and security telemetry

### Events to audit

Implemented event names are `user.registered`, `auth.login_succeeded`, `auth.refresh_reuse_detected`, `auth.logout`, `auth.mfa_setup_started`, `auth.mfa_enabled`, `profile.updated`, `admin.user_status_changed`, `doctor.approved`/`doctor.deactivated`, `availability.created`/`availability.blocked`, `consultation.booked`/`consultation.status_changed`/`consultation.viewed`, `prescription.issued`, and `payment.status_changed`.

The current audit set does not record login/MFA failures, successful refresh, consultation-list queries, idempotency conflicts, admin query use, key/config/deployment/backup operations, or authorization denials. A consultation-detail read is audited and includes embedded prescription access. The missing events, plus future reset/recovery, webhook, export, break-glass, and prescription-amendment events, are production backlog items.

### Audit event shape

The implemented row contains a monotonic bigint ID, UTC timestamp, optional actor ID, action, resource type/ID, allowlisted JSON metadata, IP address, and request ID. It does not yet contain actor type, session ID, outcome/reason, source channel, trace ID, schema/service version, or an explicit patient subject.

Passwords, raw tokens, TOTP seeds/codes, encryption keys, full request/response bodies, prescription text, consultation notes, and card data must not be recorded. A versioned audit-event schema and automated metadata allowlist tests remain gates.

### Integrity, access, and monitoring

- Implemented business audits are written in the same PostgreSQL transaction as their mutation. A database trigger rejects updates and deletes from `audit_logs` for every database role using that table.
- `GET /v1/admin/audit-logs` requires admin role plus MFA and supports action/resource-type filtering with offset pagination. There is no separate auditor role or audit of audit-log queries; consultation-detail reads do emit `consultation.viewed`.
- External immutable storage, signed/hash-chained batches, independent retention control, audit-gap monitoring, and query/export alerts remain production gates.
- Current Prometheus alerts cover availability, 5xx rate, HTTP latency, memory, pending-outbox backlog, and dead-letter presence. Oldest-outbox age/retry rate, security, audit-gap, key/decryption, and anomalous-record-access metrics/alerts are not yet emitted.
- Pino has explicit credential/MFA redaction paths; automated redaction tests and telemetry retention/access controls remain gates.

## 12. OWASP API Security Top 10 (2023) mapping

| Risk                                                   | Current coverage and remaining verification                                                                                                                                                                                                                                                  |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API1 - Broken Object Level Authorization               | Patient/doctor consultation reads and writes are scoped by ownership/assignment, UUID parameters are validated, and admins are excluded from clinical routes. Full cross-user/cross-doctor negative coverage and any future break-glass design remain gates                                  |
| API2 - Broken Authentication                           | Argon2id, 15-minute HS256 JWTs with issuer/audience validation, rotating digested refresh tokens/reuse response, pending TOTP setup, and replay-step consumption are implemented. Password/MFA recovery, enforced privileged enrollment, JWT-key rotation, and broader negative tests remain |
| API3 - Broken Object Property Level Authorization      | Global DTO allowlisting and many explicit Prisma selections/mappers are implemented. A route-by-route mass-assignment and sensitive-response test matrix remains                                                                                                                             |
| API4 - Unrestricted Resource Consumption               | Fixed-window rate limits, fallback limiting, page/range/array/text caps, 1 MiB reference-ingress limit, outbox batch/attempt caps, and a k6 scenario exist. Provider/query timeouts, cost budgets, and recorded load evidence remain                                                         |
| API5 - Broken Function Level Authorization             | Global JWT guard, role/MFA metadata, service-level participant checks, and explicit exclusion of admins from clinical controllers exist. A complete tested route/role matrix and a purpose-bound design for any future emergency access remain gates                                         |
| API6 - Unrestricted Access to Sensitive Business Flows | Booking/availability/prescription idempotency, 24-hour expired-key reuse, database invariants, transition matrices, and MFA-gated privileged flows exist. Anomaly detection, physical idempotency cleanup, and future export/reset anti-automation remain                                    |
| API7 - Server Side Request Forgery                     | The current API performs no caller-controlled outbound fetch and has no provider adapter. Destination allowlists, egress filtering, private/link-local blocking, redirect policy, and SSRF tests are mandatory when an adapter is added                                                      |
| API8 - Security Misconfiguration                       | Startup environment validation, Helmet, configured CORS, normalized errors, non-root/read-only containers, NetworkPolicy, and scans exist. Health/metrics/docs exposure must remain network-scoped and production TLS/secrets/DB/Redis hardening must be verified                            |
| API9 - Improper Inventory Management                   | A generated OpenAPI artifact, `/v1` route prefix, and CI regeneration/drift check exist. A supported-version/deprecation policy and integration ownership inventory remain gates                                                                                                             |
| API10 - Unsafe Consumption of APIs                     | No external provider response is consumed in the reference handler. Future integrations require TLS verification, signed/replay-safe webhooks, strict response schemas, minimum shared data, timeouts/circuit breakers, and state-machine validation                                         |

## 13. Secure delivery and dependency controls

- Use OWASP ASVS 5.0 Level 2 as the production verification baseline for application controls; document any inapplicable requirement and its rationale.
- Pin dependencies through the lockfile; review automated updates; block known exploitable critical/high findings unless a time-bounded, owner-approved exception documents compensating controls.
- Current CI runs exact dependency installation, formatting, linting, type checking, unit coverage, database migration, the PostgreSQL/Redis secured-workflow e2e suite with `RUN_E2E=true`, OpenAPI regeneration/drift checking, production build, `npm audit --audit-level=high`, and HIGH/CRITICAL Trivy scans for both runtime and migration images.
- The release workflow must pass reusable CI, publishes commit-addressed runtime/migration images with BuildKit SBOM/provenance attestations, scans them by digest, and renders digest-pinned Kubernetes manifests. Secret scanning, SAST, image signing, and evidence that required reviewers/approval rules are enabled on the referenced GitHub `production` environment remain production gates.
- The multi-stage image prunes development dependencies and runs as non-root. Compose and Kubernetes use a read-only filesystem; Kubernetes also drops capabilities and defines CPU/memory/temporary-storage controls.
- Separate build/deployment identities, workload identity, and short-lived deployment credentials depend on the target platform and are not configured here. The workflow references a GitHub `production` environment, but its protection rules live in repository settings and cannot be proven by this codebase.
- Secrets are runtime environment values from Compose or a Kubernetes Secret example. An external secret manager and protections against diagnostic/configuration disclosure remain gates.
- Patch internet-exploitable critical issues immediately through the incident process; target 7 days for other criticals, 30 days for highs, and the next planned cycle for lower severities. Exceptions require owner, rationale, expiry, and monitoring.
- Perform authorization and business-logic testing in addition to automated scanners; scanners do not prove BOLA, state-machine, or idempotency safety.

## 14. Retention, privacy, and deletion assumptions

These are design assumptions for the assignment and must be approved before production:

1. The initial deployment serves one defined legal region and keeps primary data, backups, logs, and keys in approved regions.
2. The MVP does not serve minors, store audio/video recordings, ingest wearable data, or store card data. Adding any of these requires a new privacy and threat review.
3. Health and prescription records are retained according to the applicable clinical-record schedule, not a developer-selected arbitrary period. The production value is a policy configuration owned by Legal/Privacy and Clinical Operations.
4. Implemented technical defaults are 15-minute access tokens and 30-day refresh tokens. Idempotency keys become atomically reusable after 24 hours, but no physical row-cleanup job exists. Application-log and security-telemetry retention are deployment-specific and unset by the service.
5. Audit and clinical-record retention, archive period, and legal-hold behavior are unresolved production gates. Backups follow the same deletion policy with a documented expiry lag.
6. Setting a user to `DELETED` disables token authentication and revokes active refresh tokens, but it does not delete or anonymize records. A post-hold deletion/anonymization workflow is a production gate.
7. There is no dedicated data-subject access/export/deletion workflow. Production must add verified identity, minimum-necessary disclosure, dual review for sensitive exports, and auditable processing.
8. Analytics use aggregation or pseudonymization. Re-identification, advertising use of clinical data, and sale of personal/health data are prohibited.

A retention register must name the dataset, purpose, lawful basis where applicable, owner, location, retention period, deletion method, backup behavior, and legal-hold process before launch.

## 15. Incident response notes

Potential incidents include credential stuffing, refresh-token reuse, anomalous patient-record access, unauthorized role change, leaked secret/key, vulnerable dependency under exploitation, PHI in telemetry, database/backup access, webhook forgery, audit gaps, ransomware, and sustained availability attack.

1. **Detect and triage:** open an incident with UTC timeline, affected environment/data, confidence, severity, incident commander, and evidence locations. Avoid copying PHI into chat or tickets.
2. **Contain:** revoke sessions/credentials, disable affected integration or route, isolate workloads, block indicators, preserve database/audit/cloud evidence, and enable approved temporary limits. Do not destroy evidence by immediately rebuilding every affected resource.
3. **Eradicate:** patch the root cause, rotate secrets and keys in dependency order, remove persistence, validate images/configuration, and scan adjacent systems.
4. **Recover:** restore from a known-good point, run integrity and authorization checks, reconcile outbox/payment/booking state, monitor closely, and obtain incident-owner approval before full traffic.
5. **Notify:** Security/Privacy and counsel determine contractual, regulator, and affected-person notification duties and deadlines. Engineering does not make that determination alone.
6. **Learn:** complete a blameless post-incident review with root cause, control failures, detection gaps, actions, owners, due dates, and threat-model updates.

Key-specific response: stop new use of the key, identify all encrypted/signed/token data under that version, rotate and revoke, rewrap/re-encrypt where needed, invalidate affected sessions or signatures, and retain controlled access to historical encryption keys only when necessary for recovery.

## 16. Production security checklist

Items marked complete document design decisions only. Operational and implementation items remain unchecked until evidence is attached in the release record.

### Threat model and privacy

- [x] System scope, assets, actors, trust boundaries, and STRIDE threats are documented.
- [x] Data classes and prohibited telemetry/payment data are documented.
- [ ] OWASP ASVS 5.0 Level 2 applicability and verification evidence are recorded for the release.
- [ ] Product, Clinical, Privacy, and Legal approve jurisdiction, consent, minors, residency, retention, deletion, breach, and clinical-record requirements.
- [ ] Every third party has an owner, data-flow entry, minimum-data review, security assessment, and deletion/incident terms.
- [ ] A privacy impact assessment and retention register are approved.

### Authentication and authorization

- [ ] Argon2id parameters are benchmarked and tested; passwords and reset tokens never appear in logs.
- [ ] JWT algorithm/issuer/audience/type/expiry checks and signing-key rotation are covered by negative tests.
- [ ] Refresh tokens are opaque, hashed, atomically rotated, family-revoked on reuse, and tested under concurrency.
- [ ] TOTP is mandatory for doctor/admin roles; seeds are encrypted; recovery codes are hashed; replay/reset controls are tested.
- [ ] Route and domain authorization matrices cover patient, doctor, admin, service, disabled user, and unauthenticated cases.
- [ ] Cross-user/cross-doctor BOLA and mass-assignment tests exist for every resource endpoint.
- [ ] Break-glass access is time-bound, reasoned, alerted, and independently reviewed.

### Data and cryptography

- [ ] TLS is enforced externally and for PostgreSQL, Redis, telemetry, and provider connections where supported.
- [ ] Storage, snapshots, backups, and log stores are encrypted.
- [ ] PHI fields use versioned AES-256-GCM envelope encryption with unique nonces, authenticated context, and KMS/HSM-protected KEKs.
- [ ] Keys are separated by purpose; access is least-privilege and audited; normal and emergency rotation drills pass.
- [ ] Production data is excluded from non-production; test fixtures are synthetic.
- [ ] Response DTOs and Prisma selections prevent hashes, secrets, encrypted blobs, and internal fields from serialization.
- [ ] No PAN/CVV or raw payment credentials are stored.

### API and business logic

- [ ] Validation rejects unknown fields, invalid content types, oversized inputs, unsafe filter/sort fields, and unbounded pagination/ranges.
- [ ] Booking uniqueness is enforced by PostgreSQL and passes a concurrent double-booking test.
- [ ] Idempotency binds actor/method/route/request hash, returns the original outcome, rejects mismatched replays, and expires predictably.
- [ ] Consultation, booking, payment, and prescription state machines reject skipped/forbidden transitions.
- [ ] Issued prescriptions are immutable; any future amendment/revocation creates an attributable version instead of overwriting the original.
- [ ] Rate, concurrency, timeout, retry-budget, and circuit-breaker controls are tested for expensive and sensitive flows.
- [ ] SSRF, webhook forgery/replay, injection, and unsafe-provider-response tests pass.
- [ ] CORS, cookies/CSRF where applicable, security headers, error responses, docs, health, and metrics have production-safe configuration.

### Audit, monitoring, and resilience

- [ ] Required auth, clinical, administrative, key, deployment, backup, and break-glass events are emitted with request/trace correlation.
- [ ] Audit writes cannot be silently omitted from successful business transactions; external storage is append-only/immutable and access-controlled.
- [ ] Logs/traces/metrics are allowlisted and redaction tests prove they contain no raw tokens, secrets, request bodies, or PHI.
- [ ] Alerts exist for credential attacks, refresh reuse, anomalous record access/export, privilege changes, oldest due outbox event/backlog, audit gaps, and key errors.
- [ ] Encrypted backup restore and point-in-time recovery drills meet documented RPO/RTO and include required historical keys.
- [ ] Incident contacts, severity rules, evidence handling, communications, provider escalation, and breach-decision ownership are exercised.

### Supply chain and platform

- [ ] CI runs tests, SAST, SCA, secret scan, container scan, lockfile verification, SBOM, and image provenance/signing checks.
- [ ] Images run non-root with minimal packages, read-only filesystem where practical, dropped capabilities, and resource limits.
- [ ] Kubernetes namespaces, service accounts, NetworkPolicy, ingress, egress, and secret access implement least privilege.
- [ ] Runtime and migration database roles are separate; Redis is private/authenticated and uses scoped prefixes/ACLs.
- [ ] Branch protection, reviewed migrations, production approvals, and short-lived CI/deployment identities are enabled.
- [ ] No unresolved exploitable critical/high dependency or configuration finding is released without an owned, expiring exception.

## 17. Open production gates

- Select and configure the production KMS/HSM and secret manager; the local development provider is not a production control.
- Approve exact clinical/audit/log/backup retention and deletion schedules.
- Confirm external payment, notification, identity-verification, and telemetry providers and threat-model their concrete webhook/data flows.
- Define the doctor verification process and the clinical rules governing prescription issue/amendment/revocation.
- Define break-glass access, support tooling, and approval/audit workflow.
- Run load, concurrency, authorization, restore, key-rotation, and incident-response exercises and attach evidence to the release record.

## 18. References

- [OWASP API Security Top 10 - 2023](https://api-security.owasp.org/editions/2023/en/0x11-t10/)
- [OWASP Application Security Verification Standard](https://owasp.org/projects/asvs)
- [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/)
- [NIST SP 800-57 Part 1 Rev. 5 - Recommendation for Key Management](https://csrc.nist.gov/pubs/sp/800/57/pt1/r5/final)
- [NIST SP 800-63B - Authentication and Lifecycle Management](https://pages.nist.gov/800-63-4/sp800-63b.html)
