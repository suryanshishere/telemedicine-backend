import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SlotStatus, UserStatus } from '@prisma/client';
import { AuditService } from '../../common/services/audit.service';
import { IdempotencyService } from '../../common/services/idempotency.service';
import { RedisService } from '../../common/services/redis.service';
import { AuditContext, AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../database/prisma.service';
import { AvailabilityQueryDto, CreateAvailabilityDto, DoctorSearchDto } from './dto/doctor.dto';

@Injectable()
export class DoctorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  async search(query: DoctorSearchDto) {
    const cacheKey = `doctors:search:${Buffer.from(JSON.stringify(query)).toString('base64url')}`;
    const cached = await this.redis.getJson<object>(cacheKey);
    if (cached) return cached;

    const where: Prisma.DoctorWhereInput = {
      active: true,
      user: { status: UserStatus.ACTIVE },
      specialization: query.specialization
        ? { equals: query.specialization, mode: 'insensitive' }
        : undefined,
      consultationFeeCents:
        query.minFeeCents !== undefined || query.maxFeeCents !== undefined
          ? { gte: query.minFeeCents, lte: query.maxFeeCents }
          : undefined,
      ...(query.search
        ? {
            OR: [
              { specialization: { contains: query.search, mode: 'insensitive' } },
              { user: { profile: { fullName: { contains: query.search, mode: 'insensitive' } } } },
            ],
          }
        : {}),
      availabilitySlots: query.availableFrom
        ? {
            some: {
              status: SlotStatus.AVAILABLE,
              startsAt: {
                gte: new Date(Math.max(new Date(query.availableFrom).getTime(), Date.now())),
              },
            },
          }
        : undefined,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.doctor.findMany({
        where,
        select: {
          id: true,
          specialization: true,
          bio: true,
          consultationFeeCents: true,
          user: { select: { profile: { select: { fullName: true } } } },
        },
        orderBy: [{ consultationFeeCents: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.doctor.count({ where }),
    ]);
    const result = {
      items: rows.map((row) => ({
        id: row.id,
        fullName: row.user.profile?.fullName,
        specialization: row.specialization,
        bio: row.bio,
        consultationFeeCents: row.consultationFeeCents,
      })),
      page: query.page,
      limit: query.limit,
      total,
    };
    await this.redis.setJson(cacheKey, result, 30);
    return result;
  }

  async availability(doctorId: string, query: AvailabilityQueryDto) {
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (to <= from || to.getTime() - from.getTime() > 31 * 86_400_000) {
      throw new BadRequestException('Availability range must be positive and no more than 31 days');
    }
    const exists = await this.prisma.doctor.count({
      where: { id: doctorId, active: true, user: { status: UserStatus.ACTIVE } },
    });
    if (!exists) throw new NotFoundException('Doctor not found');
    return this.prisma.availabilitySlot.findMany({
      where: {
        doctorId,
        status: SlotStatus.AVAILABLE,
        startsAt: { gte: new Date(Math.max(from.getTime(), Date.now())) },
        endsAt: { lte: to },
      },
      select: { id: true, startsAt: true, endsAt: true, status: true },
      orderBy: { startsAt: 'asc' },
    });
  }

  async createAvailability(
    user: AuthUser,
    dto: CreateAvailabilityDto,
    key: string,
    context: AuditContext,
  ) {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (startsAt <= new Date() || endsAt <= startsAt) {
      throw new BadRequestException('Slot must be a future, positive UTC interval');
    }
    const minutes = (endsAt.getTime() - startsAt.getTime()) / 60_000;
    if (minutes < 10 || minutes > 240) {
      throw new BadRequestException('Slot length must be between 10 and 240 minutes');
    }

    try {
      return await this.idempotency.execute({
        userId: user.id,
        route: 'POST:/v1/doctors/me/availability',
        key: IdempotencyService.validateKey(key),
        request: dto,
        successStatus: 201,
        handler: async (tx) => {
          const doctor = await tx.doctor.findUnique({ where: { userId: user.id } });
          if (!doctor || !doctor.active)
            throw new NotFoundException('Active doctor profile not found');
          const slot = await tx.availabilitySlot.create({
            data: { doctorId: doctor.id, startsAt, endsAt },
            select: { id: true, doctorId: true, startsAt: true, endsAt: true, status: true },
          });
          await this.audit.write(tx, {
            actorId: user.id,
            action: 'availability.created',
            resourceType: 'availability_slot',
            resourceId: slot.id,
            context,
          });
          return slot;
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('An availability slot already starts at that time');
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2004') {
        throw new ConflictException('Availability overlaps another active slot');
      }
      throw error;
    } finally {
      await this.redis.deleteByPrefix('doctors:search:');
    }
  }

  async blockAvailability(user: AuthUser, slotId: string, context: AuditContext) {
    const result = await this.prisma.$transaction(async (tx) => {
      const doctor = await tx.doctor.findUnique({ where: { userId: user.id } });
      if (!doctor) throw new NotFoundException('Doctor profile not found');
      const current = await tx.availabilitySlot.findFirst({
        where: { id: slotId, doctorId: doctor.id },
        select: { status: true, startsAt: true },
      });
      if (!current) throw new NotFoundException('Availability slot not found');
      if (current.status === SlotStatus.BLOCKED) {
        return { id: slotId, status: SlotStatus.BLOCKED };
      }
      if (current.startsAt <= new Date()) {
        throw new ConflictException('Past availability cannot be changed');
      }
      const updated = await tx.availabilitySlot.updateMany({
        where: { id: slotId, doctorId: doctor.id, status: SlotStatus.AVAILABLE },
        data: { status: SlotStatus.BLOCKED, version: { increment: 1 } },
      });
      if (updated.count !== 1) throw new ConflictException('Slot is not available to block');
      await this.audit.write(tx, {
        actorId: user.id,
        action: 'availability.blocked',
        resourceType: 'availability_slot',
        resourceId: slotId,
        context,
      });
      return { id: slotId, status: SlotStatus.BLOCKED };
    });
    await this.redis.deleteByPrefix('doctors:search:');
    return result;
  }

  async setActive(actorId: string, doctorId: string, active: boolean, context: AuditContext) {
    const result = await this.prisma.$transaction(async (tx) => {
      const exists = await tx.doctor.count({ where: { id: doctorId } });
      if (!exists) throw new NotFoundException('Doctor not found');
      const current = await tx.doctor.findUniqueOrThrow({
        where: { id: doctorId },
        include: { user: { select: { status: true } } },
      });
      if (active && current.user.status !== UserStatus.ACTIVE) {
        throw new ConflictException('Suspended users cannot be approved as active doctors');
      }
      if (current.active === active) {
        return {
          id: current.id,
          userId: current.userId,
          specialization: current.specialization,
          active: current.active,
          updatedAt: current.updatedAt,
        };
      }
      const doctor = await tx.doctor.update({
        where: { id: doctorId },
        data: { active },
        select: {
          id: true,
          userId: true,
          specialization: true,
          active: true,
          updatedAt: true,
        },
      });
      await this.audit.write(tx, {
        actorId,
        action: active ? 'doctor.approved' : 'doctor.deactivated',
        resourceType: 'doctor',
        resourceId: doctorId,
        metadata: { userId: doctor.userId },
        context,
      });
      return doctor;
    });
    await this.redis.deleteByPrefix('doctors:search:');
    return result;
  }
}
