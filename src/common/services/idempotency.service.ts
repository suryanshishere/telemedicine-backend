import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { IdempotencyStatus, Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';

export interface IdempotentResult<T> {
  value: T;
  statusCode: number;
  replayed: boolean;
}

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  static validateKey(key?: string): string {
    if (!key || !/^[A-Za-z0-9._:-]{8,100}$/.test(key)) {
      throw new BadRequestException(
        'Idempotency-Key is required and must be 8-100 URL-safe characters',
      );
    }
    return key;
  }

  async execute<T extends object>(params: {
    userId: string;
    route: string;
    key: string;
    request: unknown;
    successStatus: number;
    handler: (tx: Prisma.TransactionClient) => Promise<T>;
  }): Promise<IdempotentResult<T>> {
    const requestHash = createHash('sha256').update(stableJson(params.request)).digest('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);

    return this.prisma.$transaction(
      async (tx) => {
        const claimed = await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`INSERT INTO "idempotency_records"
            ("id", "user_id", "route", "key", "request_hash", "status", "expires_at", "created_at", "updated_at")
            VALUES (${randomUUID()}::uuid, ${params.userId}::uuid, ${params.route}, ${params.key}, ${requestHash}, 'PROCESSING'::"IdempotencyStatus", ${expiresAt}, NOW(), NOW())
            ON CONFLICT ("user_id", "route", "key") DO UPDATE SET
              "id" = EXCLUDED."id",
              "request_hash" = EXCLUDED."request_hash",
              "status" = 'PROCESSING'::"IdempotencyStatus",
              "response_code" = NULL,
              "response_body" = NULL,
              "expires_at" = EXCLUDED."expires_at",
              "created_at" = NOW(),
              "updated_at" = NOW()
            WHERE "idempotency_records"."expires_at" <= NOW()
            RETURNING "id"`,
        );

        if (claimed.length === 0) {
          const existing = await tx.idempotencyRecord.findUniqueOrThrow({
            where: {
              userId_route_key: {
                userId: params.userId,
                route: params.route,
                key: params.key,
              },
            },
          });
          if (existing.requestHash !== requestHash) {
            throw new ConflictException(
              'Idempotency-Key was already used with a different request',
            );
          }
          if (
            existing.status === IdempotencyStatus.COMPLETED &&
            existing.responseBody &&
            existing.responseCode
          ) {
            return {
              value: existing.responseBody as T,
              statusCode: existing.responseCode,
              replayed: true,
            };
          }
          throw new ConflictException('An identical request is already being processed');
        }

        const value = await params.handler(tx);
        await tx.idempotencyRecord.update({
          where: {
            userId_route_key: {
              userId: params.userId,
              route: params.route,
              key: params.key,
            },
          },
          data: {
            status: IdempotencyStatus.COMPLETED,
            responseCode: params.successStatus,
            responseBody: JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue,
          },
        });
        return { value, statusCode: params.successStatus, replayed: false };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10_000 },
    );
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
