import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConsultationStatus, PaymentStatus, Role, UserStatus } from '@prisma/client';
import { RedisService } from '../../src/common/services/redis.service';
import { AuditService } from '../../src/common/services/audit.service';
import { CryptoService } from '../../src/common/services/crypto.service';
import { AuditContext } from '../../src/common/types/auth-user';
import { PrismaService } from '../../src/database/prisma.service';
import { AdminService } from '../../src/modules/admin/admin.service';
import { UsersService } from '../../src/modules/users/users.service';

const context: AuditContext = { requestId: 'request-1', ipAddress: '127.0.0.1' };
const actorId = '11111111-1111-4111-8111-111111111111';
const targetId = '22222222-2222-4222-8222-222222222222';

function usersHarness() {
  const tx = {
    profile: { update: jest.fn() },
    user: { findUnique: jest.fn(), update: jest.fn() },
    doctor: { updateMany: jest.fn() },
    refreshToken: { updateMany: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const prisma = {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    auditLog: { findMany: jest.fn(), count: jest.fn() },
    $transaction: jest.fn(
      async (input: ((client: typeof tx) => Promise<unknown>) | Promise<unknown>[]) =>
        Array.isArray(input) ? Promise.all(input) : input(tx),
    ),
  };
  const crypto = {
    encrypt: jest.fn((value: string) => `encrypted:${value}`),
    decrypt: jest.fn((value: string) => value.replace('encrypted:', '')),
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const service = new UsersService(
    prisma as unknown as PrismaService,
    crypto as unknown as CryptoService,
    audit as unknown as AuditService,
  );
  return { service, prisma, tx, crypto, audit };
}

describe('UsersService', () => {
  it('returns a safe current-user view and decrypts the phone at the boundary', async () => {
    const { service, prisma, crypto } = usersHarness();
    const createdAt = new Date('2026-09-01T00:00:00.000Z');
    prisma.user.findUnique.mockResolvedValue({
      id: targetId,
      email: 'doctor@example.test',
      role: Role.DOCTOR,
      status: UserStatus.ACTIVE,
      mfaEnabled: true,
      createdAt,
      profile: {
        fullName: 'Doctor One',
        phoneEncrypted: 'encrypted:+919876543210',
        dateOfBirth: new Date('1985-01-01T00:00:00.000Z'),
      },
      doctor: {
        id: '33333333-3333-4333-8333-333333333333',
        specialization: 'Ayurveda',
        bio: 'Bio',
        consultationFeeCents: 15_000,
        active: true,
      },
    });

    const result = await service.me(targetId);

    expect(crypto.decrypt).toHaveBeenCalledWith('encrypted:+919876543210');
    expect(result).toEqual(
      expect.objectContaining({
        id: targetId,
        profile: expect.objectContaining({ phone: '+919876543210' }),
        doctor: expect.objectContaining({ specialization: 'Ayurveda', active: true }),
      }),
    );
    expect(result).not.toHaveProperty('passwordHash');
    expect(result.profile).not.toHaveProperty('phoneEncrypted');
  });

  it('fails closed when the current user no longer exists', async () => {
    const { service, prisma } = usersHarness();
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.me(targetId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('encrypts profile PII and records changed fields in the same transaction', async () => {
    const { service, tx, crypto, audit } = usersHarness();
    const updatedAt = new Date('2026-09-18T10:00:00.000Z');
    tx.profile.update.mockResolvedValue({
      fullName: 'Updated Name',
      dateOfBirth: new Date('1990-01-02T00:00:00.000Z'),
      updatedAt,
    });

    await service.updateProfile(
      targetId,
      { fullName: '  Updated Name  ', phone: '+919876543210', dateOfBirth: '1990-01-02' },
      context,
    );

    expect(tx.profile.update).toHaveBeenCalledWith({
      where: { userId: targetId },
      data: {
        fullName: 'Updated Name',
        phoneEncrypted: 'encrypted:+919876543210',
        dateOfBirth: new Date('1990-01-02'),
      },
      select: { fullName: true, dateOfBirth: true, updatedAt: true },
    });
    expect(crypto.encrypt).toHaveBeenCalledWith('+919876543210');
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        actorId: targetId,
        action: 'profile.updated',
        metadata: { fields: ['fullName', 'phone', 'dateOfBirth'] },
        context,
      }),
    );
  });

  it('prevents an administrator from suspending their own active session', async () => {
    const { service, prisma } = usersHarness();

    await expect(
      service.updateStatus(actorId, actorId, UserStatus.SUSPENDED, context),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('atomically deactivates a doctor, revokes sessions, and audits suspension', async () => {
    const { service, tx, audit } = usersHarness();
    const current = {
      id: targetId,
      email: 'doctor@example.test',
      role: Role.DOCTOR,
      status: UserStatus.ACTIVE,
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    };
    const suspended = { ...current, status: UserStatus.SUSPENDED };
    tx.user.findUnique.mockResolvedValue(current);
    tx.user.update.mockResolvedValue(suspended);

    await expect(
      service.updateStatus(actorId, targetId, UserStatus.SUSPENDED, context),
    ).resolves.toEqual(suspended);

    expect(tx.doctor.updateMany).toHaveBeenCalledWith({
      where: { userId: targetId },
      data: { active: false },
    });
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: targetId, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        actorId,
        action: 'admin.user_status_changed',
        resourceId: targetId,
        metadata: { status: UserStatus.SUSPENDED },
      }),
    );
  });

  it('treats a repeated status update as an idempotent no-op', async () => {
    const { service, tx, audit } = usersHarness();
    const current = {
      id: targetId,
      email: 'patient@example.test',
      role: Role.PATIENT,
      status: UserStatus.SUSPENDED,
      updatedAt: new Date(),
    };
    tx.user.findUnique.mockResolvedValue(current);

    await expect(
      service.updateStatus(actorId, targetId, UserStatus.SUSPENDED, context),
    ).resolves.toEqual(current);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.doctor.updateMany).not.toHaveBeenCalled();
    expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('applies admin search filters and converts bigint audit identifiers for JSON output', async () => {
    const { service, prisma } = usersHarness();
    prisma.user.findMany.mockResolvedValue([{ id: targetId }]);
    prisma.user.count.mockResolvedValue(1);

    await expect(
      service.list({
        page: 2,
        limit: 10,
        search: 'doctor',
        role: Role.DOCTOR,
        status: UserStatus.ACTIVE,
      }),
    ).resolves.toEqual({ items: [{ id: targetId }], page: 2, limit: 10, total: 1 });
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          role: Role.DOCTOR,
          status: UserStatus.ACTIVE,
          OR: expect.any(Array),
        }),
        skip: 10,
        take: 10,
      }),
    );

    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 9_007_199_254_740_993n,
        actorId,
        action: 'auth.login_succeeded',
        resourceType: 'user',
        resourceId: targetId,
        metadata: {},
        ipAddress: '127.0.0.1',
        requestId: 'request-1',
        createdAt: new Date(),
      },
    ]);
    prisma.auditLog.count.mockResolvedValue(1);

    const logs = await service.auditLogs({
      page: 1,
      limit: 20,
      action: 'auth.',
      resourceType: 'user',
    });
    expect(logs.items[0].id).toBe('9007199254740993');
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { action: { startsWith: 'auth.' }, resourceType: 'user' },
      }),
    );
  });
});

function adminHarness() {
  const prisma = {
    consultation: { groupBy: jest.fn(), count: jest.fn() },
    payment: { aggregate: jest.fn() },
    doctor: { count: jest.fn() },
    user: { count: jest.fn() },
    $queryRaw: jest.fn(),
  };
  const redis = {
    getJson: jest.fn(),
    setJson: jest.fn().mockResolvedValue(undefined),
  };
  const service = new AdminService(
    prisma as unknown as PrismaService,
    redis as unknown as RedisService,
  );
  return { service, prisma, redis };
}

describe('AdminService analytics', () => {
  const from = '2026-09-01T00:00:00.000Z';
  const to = '2026-10-01T00:00:00.000Z';

  it('rejects reversed and excessively broad analytics ranges before querying', async () => {
    const { service, redis } = adminHarness();

    await expect(service.analytics({ from: to, to: from })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.analytics({ from: '2024-01-01T00:00:00.000Z', to })).rejects.toThrow(
      'no more than 366 days',
    );
    expect(redis.getJson).not.toHaveBeenCalled();
  });

  it('returns a cached aggregate without querying sensitive operational tables', async () => {
    const { service, prisma, redis } = adminHarness();
    const cached = { consultations: { total: 42 } };
    redis.getJson.mockResolvedValue(cached);

    await expect(service.analytics({ from, to })).resolves.toBe(cached);
    expect(prisma.consultation.groupBy).not.toHaveBeenCalled();
    expect(prisma.payment.aggregate).not.toHaveBeenCalled();
  });

  it('calculates bounded ratios, bigint daily counts, revenue, and caches the result', async () => {
    const { service, prisma, redis } = adminHarness();
    redis.getJson.mockResolvedValue(null);
    prisma.consultation.groupBy.mockResolvedValue([
      { status: ConsultationStatus.COMPLETED, _count: { _all: 3 } },
      { status: ConsultationStatus.CANCELLED, _count: { _all: 1 } },
      { status: ConsultationStatus.SCHEDULED, _count: { _all: 1 } },
    ]);
    prisma.$queryRaw.mockResolvedValue([{ day: new Date('2026-09-02T00:00:00.000Z'), total: 5n }]);
    prisma.payment.aggregate.mockResolvedValue({
      _sum: { amountCents: 45_000 },
      _count: { _all: 3 },
    });
    prisma.doctor.count.mockResolvedValue(7);
    prisma.user.count.mockResolvedValue(120);
    prisma.consultation.count.mockResolvedValue(5);

    const result = await service.analytics({ from, to });

    expect(result).toEqual(
      expect.objectContaining({
        consultations: {
          total: 5,
          byStatus: { COMPLETED: 3, CANCELLED: 1, SCHEDULED: 1 },
          completionRate: 0.6,
          cancellationRate: 0.2,
          daily: [{ day: new Date('2026-09-02T00:00:00.000Z'), total: 5 }],
        },
        revenue: {
          capturedPayments: 3,
          capturedAmountCents: 45_000,
          currency: 'INR',
        },
        supply: { activeDoctors: 7, activePatients: 120 },
      }),
    );
    expect(prisma.payment.aggregate).toHaveBeenCalledWith({
      where: {
        status: PaymentStatus.CAPTURED,
        updatedAt: { gte: new Date(from), lt: new Date(to) },
      },
      _sum: { amountCents: true },
      _count: { _all: true },
    });
    expect(redis.setJson).toHaveBeenCalledWith(`admin:analytics:${from}:${to}`, result, 60);
  });
});
