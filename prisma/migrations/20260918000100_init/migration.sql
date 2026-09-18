CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "btree_gist";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE TYPE "Role" AS ENUM ('PATIENT', 'DOCTOR', 'ADMIN');
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');
CREATE TYPE "SlotStatus" AS ENUM ('AVAILABLE', 'BOOKED', 'BLOCKED');
CREATE TYPE "ConsultationStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW');
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'AUTHORIZED', 'CAPTURED', 'REFUNDED', 'FAILED');
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED', 'DEAD_LETTER');
CREATE TYPE "IdempotencyStatus" AS ENUM ('PROCESSING', 'COMPLETED');

CREATE TABLE "users" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" VARCHAR(320) NOT NULL UNIQUE,
  "password_hash" VARCHAR(255) NOT NULL,
  "role" "Role" NOT NULL,
  "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
  "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
  "mfa_secret_encrypted" TEXT,
  "mfa_pending_secret_encrypted" TEXT,
  "mfa_last_used_step" INTEGER,
  "password_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "users_role_status_idx" ON "users"("role", "status");
CREATE INDEX "users_email_trgm_idx" ON "users" USING GIN ("email" gin_trgm_ops);

CREATE TABLE "profiles" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL UNIQUE REFERENCES "users"("id") ON DELETE CASCADE,
  "full_name" VARCHAR(120) NOT NULL,
  "phone_encrypted" TEXT,
  "date_of_birth" DATE,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "profiles_full_name_trgm_idx" ON "profiles" USING GIN ("full_name" gin_trgm_ops);

CREATE TABLE "doctors" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL UNIQUE REFERENCES "users"("id") ON DELETE RESTRICT,
  "specialization" VARCHAR(100) NOT NULL,
  "license_number_encrypted" TEXT NOT NULL,
  "bio" VARCHAR(2000),
  "consultation_fee_cents" INTEGER NOT NULL CHECK ("consultation_fee_cents" >= 0),
  "active" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "doctors_specialization_active_idx" ON "doctors"("specialization", "active");
CREATE INDEX "doctors_consultation_fee_cents_idx" ON "doctors"("consultation_fee_cents");
CREATE INDEX "doctors_specialization_trgm_idx" ON "doctors" USING GIN ("specialization" gin_trgm_ops);

CREATE TABLE "availability_slots" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "doctor_id" UUID NOT NULL REFERENCES "doctors"("id") ON DELETE CASCADE,
  "starts_at" TIMESTAMPTZ(3) NOT NULL,
  "ends_at" TIMESTAMPTZ(3) NOT NULL,
  "status" "SlotStatus" NOT NULL DEFAULT 'AVAILABLE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "availability_slots_time_check" CHECK ("ends_at" > "starts_at"),
  CONSTRAINT "availability_slots_doctor_id_starts_at_key" UNIQUE ("doctor_id", "starts_at")
);
CREATE INDEX "availability_slots_doctor_id_status_starts_at_idx" ON "availability_slots"("doctor_id", "status", "starts_at");
ALTER TABLE "availability_slots" ADD CONSTRAINT "availability_slots_no_overlap"
  EXCLUDE USING gist ("doctor_id" WITH =, tstzrange("starts_at", "ends_at", '[)') WITH &&)
  WHERE ("status" IN ('AVAILABLE', 'BOOKED'));

CREATE TABLE "consultations" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "patient_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "doctor_id" UUID NOT NULL REFERENCES "doctors"("id") ON DELETE RESTRICT,
  "slot_id" UUID NOT NULL REFERENCES "availability_slots"("id") ON DELETE RESTRICT,
  "status" "ConsultationStatus" NOT NULL DEFAULT 'SCHEDULED',
  "reason_encrypted" TEXT NOT NULL,
  "clinical_notes_encrypted" TEXT,
  "scheduled_start" TIMESTAMPTZ(3) NOT NULL,
  "scheduled_end" TIMESTAMPTZ(3) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "consultations_patient_id_scheduled_start_idx" ON "consultations"("patient_id", "scheduled_start");
CREATE INDEX "consultations_doctor_id_scheduled_start_idx" ON "consultations"("doctor_id", "scheduled_start");
CREATE INDEX "consultations_status_scheduled_start_idx" ON "consultations"("status", "scheduled_start");
CREATE INDEX "consultations_created_at_idx" ON "consultations"("created_at");
CREATE UNIQUE INDEX "consultations_one_active_per_slot_idx" ON "consultations"("slot_id")
  WHERE "status" NOT IN ('CANCELLED', 'NO_SHOW');

CREATE TABLE "prescriptions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "consultation_id" UUID NOT NULL UNIQUE REFERENCES "consultations"("id") ON DELETE RESTRICT,
  "doctor_id" UUID NOT NULL REFERENCES "doctors"("id") ON DELETE RESTRICT,
  "medications_encrypted" TEXT NOT NULL,
  "instructions_encrypted" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "prescriptions_doctor_id_created_at_idx" ON "prescriptions"("doctor_id", "created_at");

CREATE TABLE "payments" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "consultation_id" UUID NOT NULL UNIQUE REFERENCES "consultations"("id") ON DELETE RESTRICT,
  "amount_cents" INTEGER NOT NULL CHECK ("amount_cents" >= 0),
  "currency" CHAR(3) NOT NULL DEFAULT 'INR',
  "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
  "provider_reference" VARCHAR(255) UNIQUE,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "payments_status_created_at_idx" ON "payments"("status", "created_at");
CREATE INDEX "payments_status_updated_at_idx" ON "payments"("status", "updated_at");

CREATE TABLE "audit_logs" (
  "id" BIGSERIAL PRIMARY KEY,
  "actor_id" UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "action" VARCHAR(100) NOT NULL,
  "resource_type" VARCHAR(100) NOT NULL,
  "resource_id" VARCHAR(100),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "ip_address" INET,
  "request_id" VARCHAR(100) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");
CREATE INDEX "audit_logs_resource_type_resource_id_created_at_idx" ON "audit_logs"("resource_type", "resource_id", "created_at");
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

CREATE TABLE "refresh_tokens" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" CHAR(64) NOT NULL UNIQUE,
  "mfa_verified" BOOLEAN NOT NULL DEFAULT false,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "revoked_at" TIMESTAMPTZ(3),
  "replaced_by" CHAR(64),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "refresh_tokens_user_id_expires_at_idx" ON "refresh_tokens"("user_id", "expires_at");

CREATE TABLE "idempotency_records" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "route" VARCHAR(200) NOT NULL,
  "key" VARCHAR(100) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "status" "IdempotencyStatus" NOT NULL DEFAULT 'PROCESSING',
  "response_code" INTEGER,
  "response_body" JSONB,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "idempotency_records_user_id_route_key_key" UNIQUE ("user_id", "route", "key")
);
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

CREATE TABLE "outbox_events" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "aggregate_type" VARCHAR(100) NOT NULL,
  "aggregate_id" VARCHAR(100) NOT NULL,
  "event_type" VARCHAR(150) NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_at" TIMESTAMPTZ(3),
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "published_at" TIMESTAMPTZ(3)
);
CREATE INDEX "outbox_events_status_available_at_idx" ON "outbox_events"("status", "available_at");

CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update_or_delete
BEFORE UPDATE OR DELETE ON "audit_logs"
FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
