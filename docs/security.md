# Security

## Implemented controls

- Argon2id password hashing
- Short-lived JWT access tokens
- Hashed, rotating refresh tokens with reuse detection
- TOTP MFA for sensitive doctor and admin actions
- Role and resource-level authorization
- DTO validation with unknown-field rejection
- Rate limiting with Redis and bounded fallback behavior
- AES-256-GCM encryption for sensitive fields
- Append-only audit logs enforced by a database trigger
- Structured-log redaction for credentials and tokens
- Idempotent writes and database-backed booking constraints
- Environment-based secrets and non-root containers

## Access rules

| Role    | Access                                                                 |
| ------- | ---------------------------------------------------------------------- |
| Patient | Own profile and consultations; doctor search; booking and cancellation |
| Doctor  | Own availability and assigned consultations; prescription creation     |
| Admin   | User, doctor, payment, audit, and analytics administration             |

Admins are not granted routine access to clinical consultation routes.

## Sensitive data

Phone numbers, doctor license numbers, MFA secrets, consultation reasons and notes, and prescriptions are encrypted with AES-256-GCM. Passwords, tokens, MFA codes, encryption keys, and clinical request bodies must not be written to logs or audit metadata.

## Main threats and mitigations

| Threat                       | Mitigation                                                               |
| ---------------------------- | ------------------------------------------------------------------------ |
| Account compromise           | Strong password rules, Argon2id, MFA, token expiry, and refresh rotation |
| Broken object authorization  | Role guards plus ownership/doctor-assignment checks in services          |
| Double booking               | Conditional slot update and PostgreSQL constraints                       |
| Replay or duplicate writes   | Scoped idempotency keys and stored responses                             |
| Injection or mass assignment | Prisma parameterization and DTO allowlists                               |
| Sensitive-data exposure      | Field encryption, response selection, and log redaction                  |
| Audit tampering              | Append-only database trigger and transactional audit writes              |
| Denial of service            | Rate limits, pagination limits, bounded date ranges, and caching         |

## Production requirements

Before a real deployment, use TLS, managed secret storage, a KMS/HSM, restricted database roles, encrypted backups, tested restore procedures, external immutable audit retention, security monitoring, and a jurisdiction-specific privacy/compliance review. The repository demonstrates application controls but does not claim legal certification.
