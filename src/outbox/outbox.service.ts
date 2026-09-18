import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

interface ClaimedEvent {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Prisma.JsonValue;
  attempts: number;
}

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);
  private readonly maxAttempts: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.maxAttempts = config.get<number>('OUTBOX_MAX_ATTEMPTS', 8);
  }

  async processBatch(batchSize = 25): Promise<number> {
    await this.recoverExpiredLeases();
    const events = await this.prisma.$queryRaw<ClaimedEvent[]>(Prisma.sql`
      WITH candidates AS (
        SELECT "id" FROM "outbox_events"
        WHERE "status" = 'PENDING' AND "available_at" <= NOW()
        ORDER BY "created_at" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${batchSize}
      )
      UPDATE "outbox_events" AS event
      SET "status" = 'PROCESSING', "locked_at" = NOW(), "attempts" = "attempts" + 1
      FROM candidates
      WHERE event."id" = candidates."id"
      RETURNING event."id", event."aggregate_type", event."aggregate_id",
                event."event_type", event."payload", event."attempts"
    `);

    for (const event of events) {
      await this.process(event);
    }
    return events.length;
  }

  private async process(event: ClaimedEvent): Promise<void> {
    try {
      // Provider adapters receive event.id as their idempotency key. This reference
      // implementation logs delivery; production adapters plug in at this boundary.
      this.logger.log(
        JSON.stringify({
          message: 'outbox_event_dispatched',
          eventId: event.id,
          eventType: event.event_type,
          aggregateType: event.aggregate_type,
          aggregateId: event.aggregate_id,
        }),
      );
      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: { status: OutboxStatus.PUBLISHED, publishedAt: new Date(), lockedAt: null },
      });
    } catch (error) {
      const dead = event.attempts >= this.maxAttempts;
      const delaySeconds = Math.min(300, 2 ** event.attempts) + Math.floor(Math.random() * 3);
      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: dead ? OutboxStatus.DEAD_LETTER : OutboxStatus.PENDING,
          availableAt: new Date(Date.now() + delaySeconds * 1_000),
          lockedAt: null,
          lastError: (error as Error).message.slice(0, 2_000),
        },
      });
      this.logger.error(`Outbox event ${event.id} failed (attempt ${event.attempts})`);
    }
  }

  private async recoverExpiredLeases(): Promise<void> {
    await this.prisma.outboxEvent.updateMany({
      where: {
        status: OutboxStatus.PROCESSING,
        lockedAt: { lt: new Date(Date.now() - 5 * 60_000) },
      },
      data: { status: OutboxStatus.PENDING, lockedAt: null },
    });
  }
}
