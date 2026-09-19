# Assumptions

- A user has one role: `PATIENT`, `DOCTOR`, or `ADMIN`.
- Public doctor registration creates an inactive doctor profile. An MFA-authenticated admin must activate it.
- Doctors and admins use MFA for sensitive operations.
- Dates and times are stored in UTC; clients handle local-time display.
- Availability uses half-open ranges: `[startsAt, endsAt)`.
- Patients can book future available slots and cancel their own scheduled consultations.
- Only the assigned doctor can update a consultation or issue its single prescription.
- Payments are recorded and transitioned locally; no real payment gateway is connected.
- Idempotency records remain valid for 24 hours.
- Outbox events use at-least-once delivery.
- PostgreSQL is authoritative. Redis is not used for booking locks or durable data.
- The system targets 100,000 consultations per day, read p95 below 200 ms, write p95 below 500 ms, and 99.95% availability. These are design and load-test targets, not measured production claims.

## Out of scope

- Video calls and chat
- Pharmacy and insurance integrations
- Real payment settlement and webhooks
- Automated doctor-license verification
- Password recovery and MFA recovery codes
- Legal or regulatory certification
- Production backup, disaster-recovery, and key-management services
