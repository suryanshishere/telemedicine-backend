import { ConflictException, NotFoundException } from '@nestjs/common';
import { PaymentStatus, Prisma } from '@prisma/client';
import { AuditService } from '../../src/common/services/audit.service';
import { AuditContext } from '../../src/common/types/auth-user';
import { PrismaService } from '../../src/database/prisma.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';

const context: AuditContext = { requestId: 'request-1', ipAddress: '127.0.0.1' };
const paymentId = '11111111-1111-4111-8111-111111111111';
const consultationId = '22222222-2222-4222-8222-222222222222';

function payment(status: PaymentStatus, providerReference: string | null = null) {
  return {
    id: paymentId,
    consultationId,
    amountCents: 2_000,
    currency: 'INR',
    status,
    providerReference,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function transactionClient() {
  return {
    payment: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
    },
    outboxEvent: { create: jest.fn() },
  };
}

function createHarness(tx = transactionClient()) {
  const prisma = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const service = new PaymentsService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
  );
  return { service, tx, prisma, audit };
}

describe('PaymentsService state machine', () => {
  it('performs an allowed transition with compare-and-set, outbox, and audit in one transaction', async () => {
    const { service, tx, audit } = createHarness();
    const current = payment(PaymentStatus.PENDING);
    const updated = payment(PaymentStatus.AUTHORIZED, 'provider-123');
    tx.payment.findUnique.mockResolvedValue(current);
    tx.payment.updateMany.mockResolvedValue({ count: 1 });
    tx.payment.findUniqueOrThrow.mockResolvedValue(updated);

    await expect(
      service.updateStatus(
        'admin-id',
        paymentId,
        { status: PaymentStatus.AUTHORIZED, providerReference: 'provider-123' },
        context,
      ),
    ).resolves.toEqual(updated);
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { id: paymentId, status: PaymentStatus.PENDING },
      data: { status: PaymentStatus.AUTHORIZED, providerReference: 'provider-123' },
    });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: {
        aggregateType: 'payment',
        aggregateId: paymentId,
        eventType: 'payment.authorized',
        payload: { paymentId, consultationId },
      },
    });
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        actorId: 'admin-id',
        action: 'payment.status_changed',
        resourceId: paymentId,
        metadata: { from: PaymentStatus.PENDING, to: PaymentStatus.AUTHORIZED },
        context,
      }),
    );
  });

  it('treats an identical status/provider retry as idempotent without duplicate side effects', async () => {
    const { service, tx, audit } = createHarness();
    const current = payment(PaymentStatus.AUTHORIZED, 'provider-123');
    tx.payment.findUnique.mockResolvedValue(current);

    await expect(
      service.updateStatus(
        'admin-id',
        paymentId,
        { status: PaymentStatus.AUTHORIZED, providerReference: 'provider-123' },
        context,
      ),
    ).resolves.toBe(current);
    expect(tx.payment.updateMany).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('rejects a same-status retry that attempts to replace the provider reference', async () => {
    const { service, tx } = createHarness();
    tx.payment.findUnique.mockResolvedValue(payment(PaymentStatus.AUTHORIZED, 'provider-original'));

    await expect(
      service.updateStatus(
        'admin-id',
        paymentId,
        { status: PaymentStatus.AUTHORIZED, providerReference: 'provider-replacement' },
        context,
      ),
    ).rejects.toThrow('Payment status already has another provider reference');
    expect(tx.payment.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    [PaymentStatus.PENDING, PaymentStatus.CAPTURED],
    [PaymentStatus.CAPTURED, PaymentStatus.AUTHORIZED],
    [PaymentStatus.REFUNDED, PaymentStatus.CAPTURED],
    [PaymentStatus.FAILED, PaymentStatus.PENDING],
  ])('rejects invalid transition %s -> %s', async (from, to) => {
    const { service, tx } = createHarness();
    tx.payment.findUnique.mockResolvedValue(payment(from));

    await expect(
      service.updateStatus('admin-id', paymentId, { status: to }, context),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.payment.updateMany).not.toHaveBeenCalled();
  });

  it('returns not found without writing any payment side effects', async () => {
    const { service, tx, audit } = createHarness();
    tx.payment.findUnique.mockResolvedValue(null);

    await expect(
      service.updateStatus('admin-id', paymentId, { status: PaymentStatus.AUTHORIZED }, context),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.payment.updateMany).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });
});

describe('PaymentsService concurrency and provider integrity', () => {
  it('allows only one winner when concurrent requests transition the same prior state', async () => {
    const tx = transactionClient();
    let pending = true;
    tx.payment.findUnique.mockResolvedValue(payment(PaymentStatus.PENDING));
    tx.payment.updateMany.mockImplementation(async () => {
      if (!pending) return { count: 0 };
      pending = false;
      return { count: 1 };
    });
    tx.payment.findUniqueOrThrow.mockResolvedValue(payment(PaymentStatus.AUTHORIZED));
    const { service, audit } = createHarness(tx);

    const outcomes = await Promise.allSettled([
      service.updateStatus('admin-1', paymentId, { status: PaymentStatus.AUTHORIZED }, context),
      service.updateStatus('admin-2', paymentId, { status: PaymentStatus.AUTHORIZED }, context),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected).toBeDefined();
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    expect((rejected as PromiseRejectedResult).reason.message).toBe(
      'Payment changed; fetch the latest state and retry',
    );
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
    expect(audit.write).toHaveBeenCalledTimes(1);
  });

  it('maps a duplicate provider reference constraint violation to a safe conflict', async () => {
    const { service, tx, audit } = createHarness();
    tx.payment.findUnique.mockResolvedValue(payment(PaymentStatus.PENDING));
    tx.payment.updateMany.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate provider reference', {
        code: 'P2002',
        clientVersion: '6.12.0',
      }),
    );

    await expect(
      service.updateStatus(
        'admin-id',
        paymentId,
        { status: PaymentStatus.AUTHORIZED, providerReference: 'already-used' },
        context,
      ),
    ).rejects.toThrow('Provider reference is already assigned to another payment');
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });
});
