import { BadRequestException } from '@nestjs/common';
import { IdempotencyStatus, Prisma } from '@prisma/client';
import { IdempotencyService } from '../../src/common/services/idempotency.service';
import { PrismaService } from '../../src/database/prisma.service';

type SqlWithValues = { values: unknown[] };

function harness() {
  const tx = {
    $queryRaw: jest.fn(),
    idempotencyRecord: {
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
    },
  };
  const prisma = {
    $transaction: jest.fn(
      async (
        callback: (client: typeof tx) => Promise<unknown>,
        options: { isolationLevel: Prisma.TransactionIsolationLevel; timeout: number },
      ) => {
        void options;
        return callback(tx);
      },
    ),
  };
  return {
    tx,
    prisma,
    service: new IdempotencyService(prisma as unknown as PrismaService),
  };
}

const baseParams = {
  userId: '11111111-1111-4111-8111-111111111111',
  route: 'POST:/v1/bookings',
  key: 'booking-key-0001',
  request: { slotId: 'slot-1', nested: { b: 2, a: 1 } },
  successStatus: 201,
};

describe('IdempotencyService.validateKey', () => {
  it.each(['12345678', 'a'.repeat(100), 'Abc_12:-.x'])('accepts a valid key: %s', (key) => {
    expect(IdempotencyService.validateKey(key)).toBe(key);
  });

  it.each([
    undefined,
    '',
    'short',
    'contains space',
    'contains/slash',
    'ü'.repeat(8),
    'a'.repeat(101),
  ])('rejects an absent or unsafe key: %s', (key) => {
    expect(() => IdempotencyService.validateKey(key)).toThrow(BadRequestException);
  });
});

describe('IdempotencyService.execute', () => {
  it('runs a new mutation and atomically persists its response', async () => {
    const { service, prisma, tx } = harness();
    tx.$queryRaw.mockResolvedValue([{ id: 'claim-1' }]);
    const value = { id: 'consultation-1' };
    const handler = jest.fn().mockResolvedValue(value);

    await expect(service.execute({ ...baseParams, handler })).resolves.toEqual({
      value,
      statusCode: 201,
      replayed: false,
    });

    expect(handler).toHaveBeenCalledWith(tx);
    expect(tx.idempotencyRecord.update).toHaveBeenCalledWith({
      where: {
        userId_route_key: {
          userId: baseParams.userId,
          route: baseParams.route,
          key: baseParams.key,
        },
      },
      data: {
        status: IdempotencyStatus.COMPLETED,
        responseCode: 201,
        responseBody: value,
      },
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 10_000,
    });
  });

  it('replays the stored response and does not execute the handler', async () => {
    const { service, tx } = harness();
    tx.$queryRaw.mockResolvedValue([]);
    const firstSql = jest.fn();

    // Capture the canonical hash produced for this request with a successful insert.
    tx.$queryRaw.mockImplementationOnce(async (sql: SqlWithValues) => {
      firstSql(sql);
      return [{ id: 'claim-1' }];
    });
    tx.idempotencyRecord.update.mockResolvedValue({});
    await service.execute({ ...baseParams, handler: jest.fn().mockResolvedValue({ id: 'first' }) });
    const requestHash = (firstSql.mock.calls[0][0] as SqlWithValues).values[4] as string;

    tx.$queryRaw.mockResolvedValueOnce([]);
    tx.idempotencyRecord.findUniqueOrThrow.mockResolvedValue({
      requestHash,
      status: IdempotencyStatus.COMPLETED,
      responseCode: 201,
      responseBody: { id: 'first' },
    });
    const handler = jest.fn();

    await expect(service.execute({ ...baseParams, handler })).resolves.toEqual({
      value: { id: 'first' },
      statusCode: 201,
      replayed: true,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('hashes object keys canonically so property insertion order does not change identity', async () => {
    const { service, tx } = harness();
    const sqlQueries: SqlWithValues[] = [];
    tx.$queryRaw.mockImplementation(async (sql: SqlWithValues) => {
      sqlQueries.push(sql);
      return [{ id: 'claim-1' }];
    });
    tx.idempotencyRecord.update.mockResolvedValue({});

    await service.execute({
      ...baseParams,
      request: { z: 3, nested: { b: 2, a: 1 } },
      handler: jest.fn().mockResolvedValue({ id: 'one' }),
    });
    await service.execute({
      ...baseParams,
      request: { nested: { a: 1, b: 2 }, z: 3 },
      handler: jest.fn().mockResolvedValue({ id: 'two' }),
    });

    expect(sqlQueries[0].values[4]).toBe(sqlQueries[1].values[4]);
  });

  it('rejects reuse with a different request body', async () => {
    const { service, tx } = harness();
    tx.$queryRaw.mockResolvedValue([]);
    tx.idempotencyRecord.findUniqueOrThrow.mockResolvedValue({
      requestHash: 'different-hash',
      status: IdempotencyStatus.COMPLETED,
      responseCode: 201,
      responseBody: { id: 'other' },
    });

    await expect(service.execute({ ...baseParams, handler: jest.fn() })).rejects.toThrow(
      'already used with a different request',
    );
  });

  it('rejects a duplicate request that is still processing', async () => {
    const { service, tx } = harness();
    let requestHash = '';
    tx.$queryRaw.mockImplementationOnce(async (sql: SqlWithValues) => {
      requestHash = sql.values[4] as string;
      return [];
    });
    tx.idempotencyRecord.findUniqueOrThrow.mockImplementation(async () => ({
      requestHash,
      status: IdempotencyStatus.PROCESSING,
      responseCode: null,
      responseBody: null,
    }));

    await expect(service.execute({ ...baseParams, handler: jest.fn() })).rejects.toThrow(
      'already being processed',
    );
  });

  it('does not mark a record completed when the domain handler fails', async () => {
    const { service, tx } = harness();
    tx.$queryRaw.mockResolvedValue([{ id: 'claim-1' }]);

    await expect(
      service.execute({
        ...baseParams,
        handler: jest.fn().mockRejectedValue(new Error('domain failure')),
      }),
    ).rejects.toThrow('domain failure');
    expect(tx.idempotencyRecord.update).not.toHaveBeenCalled();
  });
});
