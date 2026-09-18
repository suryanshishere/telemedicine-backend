import { PrismaClient, Role } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL?.toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password || password.length < 12) {
    throw new Error('Set SEED_ADMIN_EMAIL and a SEED_ADMIN_PASSWORD of at least 12 characters');
  }
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      passwordHash,
      role: Role.ADMIN,
      profile: { create: { fullName: 'Platform Administrator' } },
    },
  });
  console.log(`Admin account ensured for ${email}; enable MFA immediately.`);
}

main()
  .finally(async () => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
