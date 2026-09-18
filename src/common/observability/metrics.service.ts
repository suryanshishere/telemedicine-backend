import { Injectable, Logger } from '@nestjs/common';
import { OutboxStatus } from '@prisma/client';
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  readonly registry = new Registry();
  readonly requestCount: Counter<'method' | 'route' | 'status'>;
  readonly requestDuration: Histogram<'method' | 'route' | 'status'>;
  readonly outboxEvents: Gauge<'status'>;

  constructor(private readonly prisma: PrismaService) {
    collectDefaultMetrics({ register: this.registry, prefix: 'amrutam_' });
    this.requestCount = new Counter({
      name: 'amrutam_http_requests_total',
      help: 'Total HTTP requests',
      labelNames: ['method', 'route', 'status'],
      registers: [this.registry],
    });
    this.requestDuration = new Histogram({
      name: 'amrutam_http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
      registers: [this.registry],
    });
    this.outboxEvents = new Gauge({
      name: 'amrutam_outbox_events',
      help: 'Current transactional outbox event count by status',
      labelNames: ['status'],
      registers: [this.registry],
      collect: async () => {
        try {
          const counts = await this.prisma.outboxEvent.groupBy({
            by: ['status'],
            _count: { _all: true },
          });
          this.outboxEvents.reset();
          for (const status of Object.values(OutboxStatus)) this.outboxEvents.set({ status }, 0);
          for (const row of counts) {
            this.outboxEvents.set({ status: row.status }, row._count._all);
          }
        } catch (error) {
          this.logger.warn(`Outbox metrics collection failed: ${(error as Error).message}`);
        }
      },
    });
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
