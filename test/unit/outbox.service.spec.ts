import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxStatus } from '@prisma/client';
import { PrismaService } from '../../src/database/prisma.service';
import { OutboxService } from '../../src/outbox/outbox.service';

const now = new Date('2026-09-18T12:00:00.000Z');

function harness(maxAttempts = 3) {
  const prisma = {
    $queryRaw: jest.fn(),
    outboxEvent: {
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const config = {
    get: jest.fn((name: string, fallback: number) =>
      name === 'OUTBOX_MAX_ATTEMPTS' ? maxAttempts : fallback,
    ),
  };
  const service = new OutboxService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
  );
  return { service, prisma };
}

function event(attempts: number) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    aggregate_type: 'consultation',
    aggregate_id: '22222222-2222-4222-8222-222222222222',
    event_type: 'consultation.booked',
    payload: { consultationId: '22222222-2222-4222-8222-222222222222' },
    attempts,
  };
}

describe('OutboxService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
    jest.spyOn(Math, 'random').mockReturnValue(0);
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('recovers expired leases, claims a bounded batch, and marks delivery published', async () => {
    const { service, prisma } = harness();
    prisma.$queryRaw.mockResolvedValue([event(1)]);
    prisma.outboxEvent.update.mockResolvedValue({});

    await expect(service.processBatch(10)).resolves.toBe(1);

    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        status: OutboxStatus.PROCESSING,
        lockedAt: { lt: new Date(now.getTime() - 5 * 60_000) },
      },
      data: { status: OutboxStatus.PENDING, lockedAt: null },
    });
    const claimSql = prisma.$queryRaw.mock.calls[0][0] as { values: unknown[] };
    expect(claimSql.values).toContain(10);
    expect(prisma.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: event(1).id },
      data: { status: OutboxStatus.PUBLISHED, publishedAt: now, lockedAt: null },
    });
  });

  it('returns zero without attempting updates when no event can be claimed', async () => {
    const { service, prisma } = harness();
    prisma.$queryRaw.mockResolvedValue([]);

    await expect(service.processBatch()).resolves.toBe(0);
    expect(prisma.outboxEvent.update).not.toHaveBeenCalled();
  });

  it('requeues a failed delivery with capped exponential backoff below the attempt limit', async () => {
    const { service, prisma } = harness(3);
    prisma.$queryRaw.mockResolvedValue([event(2)]);
    prisma.outboxEvent.update
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce({});

    await expect(service.processBatch()).resolves.toBe(1);

    expect(prisma.outboxEvent.update).toHaveBeenLastCalledWith({
      where: { id: event(2).id },
      data: {
        status: OutboxStatus.PENDING,
        availableAt: new Date(now.getTime() + 4_000),
        lockedAt: null,
        lastError: 'provider unavailable',
      },
    });
  });

  it('dead-letters an event once the configured attempt limit is reached', async () => {
    const { service, prisma } = harness(3);
    prisma.$queryRaw.mockResolvedValue([event(3)]);
    prisma.outboxEvent.update
      .mockRejectedValueOnce(new Error('permanent provider failure'))
      .mockResolvedValueOnce({});

    await expect(service.processBatch()).resolves.toBe(1);

    expect(prisma.outboxEvent.update).toHaveBeenLastCalledWith({
      where: { id: event(3).id },
      data: expect.objectContaining({
        status: OutboxStatus.DEAD_LETTER,
        lockedAt: null,
        lastError: 'permanent provider failure',
      }),
    });
  });
});
