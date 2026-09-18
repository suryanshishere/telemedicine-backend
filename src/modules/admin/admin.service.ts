import { BadRequestException, Injectable } from '@nestjs/common';
import { ConsultationStatus, PaymentStatus, Prisma, UserStatus } from '@prisma/client';
import { RedisService } from '../../common/services/redis.service';
import { PrismaService } from '../../database/prisma.service';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';

interface DailyConsultations {
  day: Date;
  total: bigint;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async analytics(query: AnalyticsQueryDto) {
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (to <= from || to.getTime() - from.getTime() > 366 * 86_400_000) {
      throw new BadRequestException('Analytics range must be positive and no more than 366 days');
    }
    const cacheKey = `admin:analytics:${from.toISOString()}:${to.toISOString()}`;
    const cached = await this.redis.getJson<object>(cacheKey);
    if (cached) return cached;

    const [byStatus, daily, revenue, activeDoctors, patients, total] = await Promise.all([
      this.prisma.consultation.groupBy({
        by: ['status'],
        where: { createdAt: { gte: from, lt: to } },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<DailyConsultations[]>(Prisma.sql`
        SELECT date_trunc('day', "created_at") AS day, COUNT(*)::bigint AS total
        FROM "consultations"
        WHERE "created_at" >= ${from} AND "created_at" < ${to}
        GROUP BY 1 ORDER BY 1 ASC
      `),
      this.prisma.payment.aggregate({
        where: { status: PaymentStatus.CAPTURED, updatedAt: { gte: from, lt: to } },
        _sum: { amountCents: true },
        _count: { _all: true },
      }),
      this.prisma.doctor.count({ where: { active: true, user: { status: UserStatus.ACTIVE } } }),
      this.prisma.user.count({ where: { role: 'PATIENT', status: UserStatus.ACTIVE } }),
      this.prisma.consultation.count({ where: { createdAt: { gte: from, lt: to } } }),
    ]);

    const statusCounts = Object.fromEntries(
      byStatus.map((entry) => [entry.status, entry._count._all]),
    ) as Partial<Record<ConsultationStatus, number>>;
    const result = {
      range: { from, to },
      consultations: {
        total,
        byStatus: statusCounts,
        completionRate: ratio(statusCounts.COMPLETED ?? 0, total),
        cancellationRate: ratio(statusCounts.CANCELLED ?? 0, total),
        daily: daily.map((row) => ({ day: row.day, total: Number(row.total) })),
      },
      revenue: {
        capturedPayments: revenue._count._all,
        capturedAmountCents: revenue._sum.amountCents ?? 0,
        currency: 'INR',
      },
      supply: { activeDoctors, activePatients: patients },
      generatedAt: new Date(),
    };
    await this.redis.setJson(cacheKey, result, 60);
    return result;
  }
}

function ratio(value: number, total: number): number {
  return total ? Math.round((value / total) * 10_000) / 10_000 : 0;
}
