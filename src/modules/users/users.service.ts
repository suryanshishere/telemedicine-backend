import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, UserStatus } from '@prisma/client';
import { AuditService } from '../../common/services/audit.service';
import { CryptoService } from '../../common/services/crypto.service';
import { AuditContext } from '../../common/types/auth-user';
import { PrismaService } from '../../database/prisma.service';
import { AdminUsersQueryDto, AuditLogQueryDto } from './dto/admin-users-query.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { profile: true, doctor: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      mfaEnabled: user.mfaEnabled,
      profile: user.profile
        ? {
            fullName: user.profile.fullName,
            phone: user.profile.phoneEncrypted
              ? this.crypto.decrypt(user.profile.phoneEncrypted)
              : null,
            dateOfBirth: user.profile.dateOfBirth,
          }
        : null,
      doctor: user.doctor
        ? {
            id: user.doctor.id,
            specialization: user.doctor.specialization,
            bio: user.doctor.bio,
            consultationFeeCents: user.doctor.consultationFeeCents,
            active: user.doctor.active,
          }
        : null,
      createdAt: user.createdAt,
    };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto, context: AuditContext) {
    return this.prisma.$transaction(async (tx) => {
      const profile = await tx.profile.update({
        where: { userId },
        data: {
          fullName: dto.fullName?.trim(),
          phoneEncrypted: dto.phone ? this.crypto.encrypt(dto.phone) : undefined,
          dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
        },
        select: { fullName: true, dateOfBirth: true, updatedAt: true },
      });
      await this.audit.write(tx, {
        actorId: userId,
        action: 'profile.updated',
        resourceType: 'profile',
        resourceId: userId,
        metadata: { fields: Object.keys(dto) },
        context,
      });
      return profile;
    });
  }

  async list(query: AdminUsersQueryDto) {
    const where: Prisma.UserWhereInput = {
      role: query.role,
      status: query.status,
      ...(query.search
        ? {
            OR: [
              { email: { contains: query.search, mode: 'insensitive' } },
              { profile: { fullName: { contains: query.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          role: true,
          status: true,
          mfaEnabled: true,
          createdAt: true,
          profile: { select: { fullName: true } },
          doctor: { select: { id: true, specialization: true, active: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items, page: query.page, limit: query.limit, total };
  }

  async updateStatus(actorId: string, targetId: string, status: UserStatus, context: AuditContext) {
    if (actorId === targetId && status !== UserStatus.ACTIVE) {
      throw new BadRequestException('Administrators cannot suspend their own active session');
    }
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.user.findUnique({
        where: { id: targetId },
        select: { id: true, email: true, role: true, status: true, updatedAt: true },
      });
      if (!current) throw new NotFoundException('User not found');
      if (current.status === status) return current;
      const user = await tx.user.update({
        where: { id: targetId },
        data: { status },
        select: { id: true, email: true, role: true, status: true, updatedAt: true },
      });
      if (status !== UserStatus.ACTIVE) {
        await tx.doctor.updateMany({ where: { userId: targetId }, data: { active: false } });
        await tx.refreshToken.updateMany({
          where: { userId: targetId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      await this.audit.write(tx, {
        actorId,
        action: 'admin.user_status_changed',
        resourceType: 'user',
        resourceId: targetId,
        metadata: { status },
        context,
      });
      return user;
    });
  }

  async auditLogs(query: AuditLogQueryDto) {
    const where: Prisma.AuditLogWhereInput = {
      action: query.action ? { startsWith: query.action } : undefined,
      resourceType: query.resourceType,
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          actorId: true,
          action: true,
          resourceType: true,
          resourceId: true,
          metadata: true,
          ipAddress: true,
          requestId: true,
          createdAt: true,
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return {
      items: items.map((item) => ({ ...item, id: item.id.toString() })),
      page: query.page,
      limit: query.limit,
      total,
    };
  }
}
