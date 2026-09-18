# ADR 001: Begin with a modular monolith

- Status: Accepted
- Date: 2026-09-18
- Decision owners: Backend team

## Context

The system must support identity and access, doctor availability, booking, consultations, prescriptions, search, audit, payments metadata, analytics, and asynchronous work. It is expected to handle 100,000 daily consultations while meeting strict consistency, latency, availability, security, and observability goals.

These domains have different responsibilities, but several critical workflows cross them. Booking requires atomic slot reservation, consultation/payment creation, audit, and an outbox record. Prescription issue similarly combines the clinical row, audit, idempotency result, and outbox event. Authentication and authorization must behave consistently everywhere. Splitting these workflows across independently deployed services at the outset would introduce distributed transactions, more credentials and network paths, cross-service authorization drift, and substantially larger operational overhead before independent scaling is proven necessary.

## Decision

Build one NestJS deployment unit as a modular monolith, plus separately scalable worker processes from the same versioned codebase.

Initial modules are:

- `auth`: credentials, MFA, and access/refresh sessions; password recovery is not implemented.
- `users`: user lifecycle, profiles, administrative user listing, and audit-log listing.
- `doctors`: doctor directory, activation, availability creation/querying/blocking, and overlap control.
- `consultations`: booking, consultation lifecycle, authorized care relationship, and one immutable prescription per consultation.
- `payments`: provider references and state reconciliation; no card storage.
- `admin`: MFA-protected aggregate analytics.
- `common`: global auth/RBAC/MFA/rate-limit guards plus encryption, idempotency, audit writing, Redis, metrics, and normalized errors.
- `health`: liveness, dependency readiness, and Prometheus exposition.
- `outbox`: durable PostgreSQL event polling; the reference handler logs dispatch and marks success rather than calling a real provider.

Each feature module owns its controllers, application service, and route-specific policy. Services currently use the shared Prisma client directly; table ownership is therefore a code-review convention, not an independently enforced persistence boundary. Cross-domain mutations that require atomicity intentionally occur in one service transaction—for example, booking updates availability and creates consultation/payment/outbox/audit rows together.

PostgreSQL remains the source of truth. Redis is used only for bounded caches and rate limits; it is not a job broker or the authority for booking uniqueness, permissions, or durable state. Mutations that must be atomic use one PostgreSQL transaction. Side effects outside PostgreSQL use a PostgreSQL transactional outbox; each future external adapter must deduplicate with the stable event ID.

Outbox workers claim small due batches with `SELECT ... FOR UPDATE SKIP LOCKED` and explicit processing state/lease metadata. Delivery is at least once: the stable event ID is available for a future provider adapter's idempotency key. Failures increment a bounded attempt counter and schedule capped exponential backoff with jitter; exhausted events enter a dead-letter state. Authorized, audited replay tooling is not implemented.

## Security consequences

- One authorization and identity implementation reduces policy drift, but every module must still enforce object- and function-level authorization in its service layer.
- Fewer network boundaries reduce exposed service-to-service APIs and credentials. Internal module calls are not implicitly trusted and must accept an explicit actor/security context.
- A shared database makes local transactions straightforward but increases blast radius. Runtime database grants, explicit Prisma selections, module ownership conventions, field encryption, and audit are required.
- A compromised API process could reach multiple domains. Container, database, secret, and egress privileges must therefore be minimal, and workers should use narrower identities where practical.
- Sensitive clinical data must not be placed in generic domain events, Redis payloads, traces, or logs. Events carry IDs and minimum necessary metadata.

## Scalability consequences

- API and worker processes can scale horizontally behind the load balancer. Stateless access-token validation and external session/rate-limit state support this.
- Outbox worker replicas and concurrency can scale independently from synchronous API traffic; `SKIP LOCKED` prevents workers from claiming the same row concurrently.
- PostgreSQL indexing, connection budgets, replicas for appropriate stale-tolerant reads, and partitioning of large append-only tables are considered before service extraction.
- Current HTTP/runtime metrics and the outbox count-by-status gauge provide a baseline. Module-level saturation, database-pool, oldest-outbox-age, retry-rate, and worker-throughput metrics are future instrumentation needed to make an evidence-based extraction decision.

## Extraction criteria

A module is considered for a separate service only when measurements show a sustained need such as:

- It requires an incompatible scaling, availability, deployment, or data-residency profile.
- Its release cadence repeatedly blocks unrelated modules.
- Its resource usage or failure mode materially threatens the rest of the system and cannot be isolated in-process.
- A clear ownership boundary exists and the operational benefit exceeds the cost of another network and consistency boundary.

Before extraction, define API/event contracts, data ownership, authentication and authorization propagation, idempotency, failure semantics, observability, migration/rollback, and a saga or compensation strategy. Database-per-service is the target after extraction; direct cross-service table access is prohibited.

## Alternatives considered

### Microservices from the beginning

Rejected for the initial release. It creates distributed consistency, authorization, deployment, observability, and on-call complexity without evidence that the expected volume requires independent services.

### Unstructured single application

Rejected. A conventional layered application without enforced domain boundaries would encourage cross-domain table access, unclear ownership, and a costly future extraction.

### Serverless function per endpoint

Rejected for the core transaction path. It complicates shared authorization policy, connection management, multi-step transactions, and predictable worker behavior. Selected asynchronous workloads may later use managed functions if their security and operational boundaries are explicit.

## Consequences

Benefits are faster delivery, transactionally safe core workflows, consistent security policy, fewer operational components, and a clear path to measured decomposition. Costs are a larger per-process blast radius, the need for strict module discipline, shared-database contention planning, and the possibility of future extraction work.

This decision is revisited when production measurements or regulatory boundaries meet an extraction criterion, not merely because the codebase grows.
