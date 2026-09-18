import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConsultationStatus, PaymentStatus, Role, SlotStatus, UserStatus } from '@prisma/client';
import { AuditService } from '../../src/common/services/audit.service';
import { CryptoService } from '../../src/common/services/crypto.service';
import { IdempotencyService } from '../../src/common/services/idempotency.service';
import { AuditContext, AuthUser } from '../../src/common/types/auth-user';
import { PrismaService } from '../../src/database/prisma.service';
import { ConsultationsService } from '../../src/modules/consultations/consultations.service';

const context: AuditContext = { requestId: 'request-1', ipAddress: '127.0.0.1' };
const patient: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'patient@example.test',
  role: Role.PATIENT,
  mfa: false,
};
const secondPatient: AuthUser = {
  ...patient,
  id: '22222222-2222-4222-8222-222222222222',
  email: 'second@example.test',
};
const doctorUser: AuthUser = {
  id: '33333333-3333-4333-8333-333333333333',
  email: 'doctor@example.test',
  role: Role.DOCTOR,
  mfa: true,
};
function transactionClient() {
  return {
    availabilitySlot: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
    consultation: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
    },
    prescription: { create: jest.fn(), findUnique: jest.fn() },
    outboxEvent: { create: jest.fn() },
    auditLog: { create: jest.fn() },
  };
}

function createHarness(tx = transactionClient()) {
  const prisma = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
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
  const crypto = {
    encrypt: jest.fn((value: string) => `encrypted:${value}`),
    decrypt: jest.fn((value: string) => value.replace(/^encrypted:/, '')),
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const service = new ConsultationsService(
    prisma as unknown as PrismaService,
    idempotency as unknown as IdempotencyService,
    crypto as unknown as CryptoService,
    audit as unknown as AuditService,
  );
  return { service, tx, prisma, idempotency, crypto, audit };
}

const future = new Date(Date.now() + 10 * 60 * 1_000);
const futureEnd = new Date(future.getTime() + 30 * 60 * 1_000);
const slot = {
  id: '55555555-5555-4555-8555-555555555555',
  doctorId: '66666666-6666-4666-8666-666666666666',
  startsAt: future,
  endsAt: futureEnd,
  status: SlotStatus.AVAILABLE,
  version: 1,
  doctor: {
    consultationFeeCents: 1_500,
    active: true,
    user: { status: UserStatus.ACTIVE },
  },
};

function createdConsultation(userId = patient.id) {
  const now = new Date();
  return {
    id: '77777777-7777-4777-8777-777777777777',
    patientId: userId,
    doctorId: slot.doctorId,
    slotId: slot.id,
    status: ConsultationStatus.SCHEDULED,
    scheduledStart: slot.startsAt,
    scheduledEnd: slot.endsAt,
    version: 1,
    createdAt: now,
    updatedAt: now,
    payment: {
      id: '88888888-8888-4888-8888-888888888888',
      amountCents: 1_500,
      currency: 'INR',
      status: PaymentStatus.PENDING,
    },
  };
}

describe('ConsultationsService booking', () => {
  it('claims the versioned slot and writes consultation, outbox, audit, and payment atomically', async () => {
    const { service, tx, idempotency, crypto, audit } = createHarness();
    const consultation = createdConsultation();
    tx.availabilitySlot.findUnique.mockResolvedValue(slot);
    tx.availabilitySlot.updateMany.mockResolvedValue({ count: 1 });
    tx.consultation.create.mockResolvedValue(consultation);

    const result = await service.book(
      patient,
      { slotId: slot.id, reason: '  recurring headache  ' },
      'booking-key-0001',
      context,
    );

    expect(result).toEqual({
      value: expect.objectContaining({ id: consultation.id }),
      statusCode: 201,
      replayed: false,
    });
    expect(idempotency.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: patient.id,
        route: 'POST:/v1/bookings',
        key: 'booking-key-0001',
        successStatus: 201,
      }),
    );
    expect(tx.availabilitySlot.updateMany).toHaveBeenCalledWith({
      where: { id: slot.id, status: SlotStatus.AVAILABLE, version: slot.version },
      data: { status: SlotStatus.BOOKED, version: { increment: 1 } },
    });
    expect(crypto.encrypt).toHaveBeenCalledWith('recurring headache');
    expect(tx.consultation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          patientId: patient.id,
          doctorId: slot.doctorId,
          slotId: slot.id,
          reasonEncrypted: 'encrypted:recurring headache',
          payment: { create: { amountCents: 1_500, currency: 'INR' } },
        }),
      }),
    );
    expect(tx.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'consultation.booked' }),
      }),
    );
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        actorId: patient.id,
        action: 'consultation.booked',
        resourceId: consultation.id,
        context,
      }),
    );
  });

  it('allows only one winner when two requests concurrently claim the same slot version', async () => {
    const tx = transactionClient();
    let available = true;
    tx.availabilitySlot.findUnique.mockImplementation(async () => ({ ...slot }));
    tx.availabilitySlot.updateMany.mockImplementation(async () => {
      if (!available) return { count: 0 };
      available = false;
      return { count: 1 };
    });
    tx.consultation.create.mockImplementation(async ({ data }: { data: { patientId: string } }) =>
      createdConsultation(data.patientId),
    );
    const { service } = createHarness(tx);

    const outcomes = await Promise.allSettled([
      service.book(
        patient,
        { slotId: slot.id, reason: 'first patient' },
        'booking-key-0001',
        context,
      ),
      service.book(
        secondPatient,
        { slotId: slot.id, reason: 'second patient' },
        'booking-key-0002',
        context,
      ),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected).toBeDefined();
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    expect((rejected as PromiseRejectedResult).reason.message).toBe('Slot is no longer available');
    expect(tx.consultation.create).toHaveBeenCalledTimes(1);
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing, past, or already-claimed slot before creating a consultation', async () => {
    const { service, tx } = createHarness();
    tx.availabilitySlot.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.book(patient, { slotId: slot.id, reason: 'reason' }, 'booking-key-0001', context),
    ).rejects.toBeInstanceOf(NotFoundException);

    tx.availabilitySlot.findUnique.mockResolvedValueOnce({
      ...slot,
      startsAt: new Date(Date.now() - 1_000),
    });
    await expect(
      service.book(patient, { slotId: slot.id, reason: 'reason' }, 'booking-key-0002', context),
    ).rejects.toThrow('Slot has already started');

    tx.availabilitySlot.findUnique.mockResolvedValueOnce(slot);
    tx.availabilitySlot.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      service.book(patient, { slotId: slot.id, reason: 'reason' }, 'booking-key-0003', context),
    ).rejects.toThrow('Slot is no longer available');
    expect(tx.consultation.create).not.toHaveBeenCalled();
  });
});

describe('ConsultationsService status transitions', () => {
  function current(overrides: Record<string, unknown> = {}) {
    return {
      ...createdConsultation(),
      doctor: { userId: doctorUser.id },
      payment: { ...createdConsultation().payment, status: PaymentStatus.CAPTURED },
      ...overrides,
    };
  }

  it('lets a patient cancel their future consultation and requests a captured-payment refund', async () => {
    const { service, tx, audit } = createHarness();
    tx.consultation.findFirst.mockResolvedValue(current());
    tx.consultation.updateMany.mockResolvedValue({ count: 1 });
    tx.consultation.findUniqueOrThrow.mockResolvedValue({
      id: createdConsultation().id,
      status: ConsultationStatus.CANCELLED,
      version: 2,
      updatedAt: new Date(),
    });

    const result = await service.updateStatus(
      patient,
      createdConsultation().id,
      { status: ConsultationStatus.CANCELLED, expectedVersion: 1 },
      context,
    );

    expect(result).toEqual(
      expect.objectContaining({ status: ConsultationStatus.CANCELLED, version: 2 }),
    );
    expect(tx.availabilitySlot.update).toHaveBeenCalledWith({
      where: { id: slot.id },
      data: { status: SlotStatus.AVAILABLE, version: { increment: 1 } },
    });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'payment.refund_requested' }),
      }),
    );
    expect(tx.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'consultation.cancelled' }),
      }),
    );
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        metadata: { from: ConsultationStatus.SCHEDULED, to: ConsultationStatus.CANCELLED },
      }),
    );
  });

  it('lets the assigned doctor start a consultation and encrypts supplied clinical notes', async () => {
    const { service, tx, crypto } = createHarness();
    tx.consultation.findFirst.mockResolvedValue(current());
    tx.consultation.updateMany.mockResolvedValue({ count: 1 });
    tx.consultation.findUniqueOrThrow.mockResolvedValue({
      id: createdConsultation().id,
      status: ConsultationStatus.IN_PROGRESS,
      version: 2,
      updatedAt: new Date(),
    });

    await service.updateStatus(
      doctorUser,
      createdConsultation().id,
      {
        status: ConsultationStatus.IN_PROGRESS,
        expectedVersion: 1,
        clinicalNotes: 'sensitive note',
      },
      context,
    );

    expect(crypto.encrypt).toHaveBeenCalledWith('sensitive note');
    expect(tx.consultation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: createdConsultation().id,
          status: ConsultationStatus.SCHEDULED,
          version: 1,
        },
        data: expect.objectContaining({
          status: ConsultationStatus.IN_PROGRESS,
          clinicalNotesEncrypted: 'encrypted:sensitive note',
        }),
      }),
    );
  });

  it('rejects unauthorized, invalid, and stale transitions', async () => {
    const { service, tx } = createHarness();

    tx.consultation.findFirst.mockResolvedValueOnce(current());
    await expect(
      service.updateStatus(
        patient,
        createdConsultation().id,
        { status: ConsultationStatus.IN_PROGRESS, expectedVersion: 1 },
        context,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    tx.consultation.findFirst.mockResolvedValueOnce(
      current({ status: ConsultationStatus.COMPLETED }),
    );
    await expect(
      service.updateStatus(
        doctorUser,
        createdConsultation().id,
        { status: ConsultationStatus.IN_PROGRESS, expectedVersion: 1 },
        context,
      ),
    ).rejects.toThrow('Cannot transition COMPLETED to IN_PROGRESS');

    tx.consultation.findFirst.mockResolvedValueOnce(current());
    tx.consultation.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      service.updateStatus(
        doctorUser,
        createdConsultation().id,
        { status: ConsultationStatus.IN_PROGRESS, expectedVersion: 99 },
        context,
      ),
    ).rejects.toThrow('fetch the latest version and retry');
  });
});
