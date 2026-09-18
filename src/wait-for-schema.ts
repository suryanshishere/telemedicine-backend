import { PrismaClient } from '@prisma/client';

interface SchemaCheck {
  users: boolean;
  consultations: boolean;
  idempotencyRecords: boolean;
  outboxEvents: boolean;
  mfaPendingSecret: boolean;
}

const prisma = new PrismaClient();
const timeoutSeconds = Number(process.env.SCHEMA_WAIT_TIMEOUT_SECONDS ?? 120);
const deadline = Date.now() + timeoutSeconds * 1_000;

async function schemaReady(): Promise<boolean> {
  const [check] = await prisma.$queryRaw<SchemaCheck[]>`
    SELECT
      to_regclass('public.users') IS NOT NULL AS "users",
      to_regclass('public.consultations') IS NOT NULL AS "consultations",
      to_regclass('public.idempotency_records') IS NOT NULL AS "idempotencyRecords",
      to_regclass('public.outbox_events') IS NOT NULL AS "outboxEvents",
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'users'
          AND column_name = 'mfa_pending_secret_encrypted'
      ) AS "mfaPendingSecret"
  `;
  return !!check && Object.values(check).every(Boolean);
}

async function main(): Promise<void> {
  while (Date.now() < deadline) {
    try {
      if (await schemaReady()) {
        console.log(JSON.stringify({ message: 'database_schema_ready' }));
        return;
      }
    } catch (error) {
      console.warn(
        JSON.stringify({ message: 'database_schema_waiting', error: (error as Error).message }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Database schema was not ready within ${timeoutSeconds} seconds`);
}

main()
  .finally(async () => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
