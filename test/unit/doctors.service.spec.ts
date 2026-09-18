import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma, Role, SlotStatus, UserStatus } from '@prisma/client';
import { AuditService } from '../../src/common/services/audit.service';
import { IdempotencyService } from '../../src/common/services/idempotency.service';
import { RedisService } from '../../src/common/services/redis.service';
import { AuditContext, AuthUser } from '../../src/common/types/auth-user';
import { PrismaService } from '../../src/database/prisma.service';
import { DoctorsService } from '../../src/modules/doctors/doctors.service';

const context: AuditContext = { requestId: 'request-1', ipAddress: '127.0.0.1' };
const doctorUser: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'doctor@example.test',
  role: Role.DOCTOR,
  mfa: true,
};
const doctorId = '22222222-2222-4222-8222-222222222222';

function transactionClient() {
  return {
    doctor: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    availabilitySlot: {
      create: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
  };
}

function createHarness(tx = transactionClient()) {
  const prisma = {
    doctor: { findMany: jest.fn(), count: jest.fn() },
    availabilitySlot: { findMany: jest.fn() },
    $transaction: jest.fn(async (operation: unknown) => {
      if (Array.isArray(operation)) return Promise.all(operation);
      return (operation as (client: typeof tx) => Promise<unknown>)(tx);
    }),
  };
  const idempotency = {
    execute: jest.fn(
      async (params: {
        successStatus: number;
        handler: (client: typeof tx) => Promise<object>;
      }) => ({
        value: await params.handler(tx),
        statusCode: params.successStatus,
        replayed: false,
      }),
    ),
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const redis = {
    getJson: jest.fn(),
    setJson: jest.fn().mockResolvedValue(undefined),
    deleteByPrefix: jest.fn().mockResolvedValue(undefined),
  };
  const service = new DoctorsService(
    prisma as unknown as PrismaService,
    idempotency as unknown as IdempotencyService,
    audit as unknown as AuditService,
    redis as unknown as RedisService,
  );
  return { service, tx, prisma, idempotency, audit, redis };
}

describe('DoctorsService search and availability security', () => {
  it('queries only approved doctors with active accounts and returns a public projection', async () => {
    const { service, prisma, redis } = createHarness();
    const availableFrom = new Date(Date.now() + 60_000).toISOString();
    prisma.doctor.findMany.mockResolvedValue([
      {
        id: doctorId,
        specialization: 'Cardiology',
        bio: 'Heart specialist',
        consultationFeeCents: 2_000,
        user: { profile: { fullName: 'Dr Test' } },
      },
    ]);
    prisma.doctor.count.mockResolvedValue(1);

    const result = await service.search({
      page: 2,
      limit: 10,
      search: 'heart',
      specialization: 'Cardiology',
      minFeeCents: 1_000,
      maxFeeCents: 3_000,
      availableFrom,
    });

    expect(prisma.doctor.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          active: true,
          user: { status: UserStatus.ACTIVE },
          specialization: { equals: 'Cardiology', mode: 'insensitive' },
          consultationFeeCents: { gte: 1_000, lte: 3_000 },
          availabilitySlots: {
            some: {
              status: SlotStatus.AVAILABLE,
              startsAt: { gte: expect.any(Date) },
            },
          },
        }),
        select: {
          id: true,
          specialization: true,
          bio: true,
          consultationFeeCents: true,
          user: { select: { profile: { select: { fullName: true } } } },
        },
        skip: 10,
        take: 10,
      }),
    );
    expect(result).toEqual({
      items: [
        {
          id: doctorId,
          fullName: 'Dr Test',
          specialization: 'Cardiology',
          bio: 'Heart specialist',
          consultationFeeCents: 2_000,
        },
      ],
      page: 2,
      limit: 10,
      total: 1,
    });
    expect(redis.setJson).toHaveBeenCalledWith(
      expect.stringMatching(/^doctors:search:/),
      result,
      30,
    );
  });

  it('serves an existing cached search without querying the database', async () => {
    const { service, prisma, redis } = createHarness();
    const cached = { items: [], page: 1, limit: 20, total: 0 };
    redis.getJson.mockResolvedValue(cached);

    await expect(service.search({ page: 1, limit: 20 })).resolves.toBe(cached);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(redis.setJson).not.toHaveBeenCalled();
  });

  it('does not expose availability for inactive or suspended doctor profiles', async () => {
    const { service, prisma } = createHarness();
    prisma.doctor.count.mockResolvedValue(0);

    await expect(
      service.availability(doctorId, {
        from: new Date(Date.now() + 60_000).toISOString(),
        to: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.doctor.count).toHaveBeenCalledWith({
      where: { id: doctorId, active: true, user: { status: UserStatus.ACTIVE } },
    });
    expect(prisma.availabilitySlot.findMany).not.toHaveBeenCalled();
  });
});

describe('DoctorsService availability writes', () => {
  const startsAt = new Date(Date.now() + 60 * 60_000);
  const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
  const dto = { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };

  it('wraps a valid slot in the idempotency boundary and records an audit event', async () => {
    const { service, tx, idempotency, audit, redis } = createHarness();
    const slot = {
      id: '33333333-3333-4333-8333-333333333333',
      doctorId,
      startsAt,
      endsAt,
      status: SlotStatus.AVAILABLE,
    };
    tx.doctor.findUnique.mockResolvedValue({ id: doctorId, active: true });
    tx.availabilitySlot.create.mockResolvedValue(slot);

    await expect(
      service.createAvailability(doctorUser, dto, 'slot-key-0001', context),
    ).resolves.toEqual({ value: slot, statusCode: 201, replayed: false });
    expect(idempotency.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: doctorUser.id,
        route: 'POST:/v1/doctors/me/availability',
        key: 'slot-key-0001',
        request: dto,
        successStatus: 201,
      }),
    );
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        actorId: doctorUser.id,
        action: 'availability.created',
        resourceId: slot.id,
        context,
      }),
    );
    expect(redis.deleteByPrefix).toHaveBeenCalledWith('doctors:search:');
  });

  it('rejects invalid intervals before entering the idempotency transaction', async () => {
    const { service, idempotency, redis } = createHarness();

    await expect(
      service.createAvailability(
        doctorUser,
        {
          startsAt: new Date(Date.now() - 60_000).toISOString(),
          endsAt: new Date(Date.now() + 60_000).toISOString(),
        },
        'slot-key-0001',
        context,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(idempotency.execute).not.toHaveBeenCalled();
    expect(redis.deleteByPrefix).not.toHaveBeenCalled();
  });

  it('rejects an unapproved doctor inside the idempotent transaction', async () => {
    const { service, tx } = createHarness();
    tx.doctor.findUnique.mockResolvedValue({ id: doctorId, active: false });

    await expect(
      service.createAvailability(doctorUser, dto, 'slot-key-0001', context),
    ).rejects.toThrow('Active doctor profile not found');
    expect(tx.availabilitySlot.create).not.toHaveBeenCalled();
  });

  it('maps database overlap enforcement to a conflict and always clears search caches', async () => {
    const { service, tx, redis } = createHarness();
    tx.doctor.findUnique.mockResolvedValue({ id: doctorId, active: true });
    tx.availabilitySlot.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('overlap', {
        code: 'P2004',
        clientVersion: '6.12.0',
      }),
    );

    await expect(
      service.createAvailability(doctorUser, dto, 'slot-key-0001', context),
    ).rejects.toThrow('Availability overlaps another active slot');
    expect(redis.deleteByPrefix).toHaveBeenCalledWith('doctors:search:');
  });

  it('uses ownership and a conditional update so another doctor or racing request cannot block a slot', async () => {
    const { service, tx, audit } = createHarness();
    tx.doctor.findUnique.mockResolvedValue({ id: doctorId });
    tx.availabilitySlot.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.blockAvailability(doctorUser, 'other-doctor-slot', context),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.availabilitySlot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'other-doctor-slot', doctorId } }),
    );

    tx.availabilitySlot.findFirst.mockResolvedValueOnce({
      status: SlotStatus.AVAILABLE,
      startsAt,
    });
    tx.availabilitySlot.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.blockAvailability(doctorUser, 'raced-slot', context)).rejects.toThrow(
      'Slot is not available to block',
    );
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('treats an already-blocked owned slot as an idempotent success', async () => {
    const { service, tx, audit } = createHarness();
    tx.doctor.findUnique.mockResolvedValue({ id: doctorId });
    tx.availabilitySlot.findFirst.mockResolvedValue({
      status: SlotStatus.BLOCKED,
      startsAt,
    });

    await expect(service.blockAvailability(doctorUser, 'blocked-slot', context)).resolves.toEqual({
      id: 'blocked-slot',
      status: SlotStatus.BLOCKED,
    });
    expect(tx.availabilitySlot.updateMany).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });
});

describe('DoctorsService administrative activation', () => {
  it('refuses to activate a doctor whose user account is suspended', async () => {
    const { service, tx, audit } = createHarness();
    tx.doctor.count.mockResolvedValue(1);
    tx.doctor.findUniqueOrThrow.mockResolvedValue({
      id: doctorId,
      userId: doctorUser.id,
      specialization: 'Cardiology',
      active: false,
      updatedAt: new Date(),
      user: { status: UserStatus.SUSPENDED },
    });

    await expect(service.setActive('admin-id', doctorId, true, context)).rejects.toThrow(
      'Suspended users cannot be approved as active doctors',
    );
    expect(tx.doctor.update).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('audits a real activation but avoids duplicate writes for an idempotent retry', async () => {
    const { service, tx, audit, redis } = createHarness();
    const current = {
      id: doctorId,
      userId: doctorUser.id,
      specialization: 'Cardiology',
      active: false,
      updatedAt: new Date(),
      user: { status: UserStatus.ACTIVE },
    };
    const activated = { ...current, active: true };
    tx.doctor.count.mockResolvedValue(1);
    tx.doctor.findUniqueOrThrow
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce({ ...activated, user: { status: UserStatus.ACTIVE } });
    tx.doctor.update.mockResolvedValue(activated);

    await expect(service.setActive('admin-id', doctorId, true, context)).resolves.toEqual(
      activated,
    );
    await expect(service.setActive('admin-id', doctorId, true, context)).resolves.toEqual({
      id: doctorId,
      userId: doctorUser.id,
      specialization: 'Cardiology',
      active: true,
      updatedAt: activated.updatedAt,
    });
    expect(tx.doctor.update).toHaveBeenCalledTimes(1);
    expect(audit.write).toHaveBeenCalledTimes(1);
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        actorId: 'admin-id',
        action: 'doctor.approved',
        metadata: { userId: doctorUser.id },
        context,
      }),
    );
    expect(redis.deleteByPrefix).toHaveBeenCalledTimes(2);
  });
});
