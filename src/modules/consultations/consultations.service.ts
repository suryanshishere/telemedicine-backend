import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ConsultationStatus,
  PaymentStatus,
  Prisma,
  Role,
  SlotStatus,
  UserStatus,
} from '@prisma/client';
import { AuditService } from '../../common/services/audit.service';
import { CryptoService } from '../../common/services/crypto.service';
import { IdempotencyService } from '../../common/services/idempotency.service';
import { AuditContext, AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../database/prisma.service';
import {
  BookConsultationDto,
  ConsultationQueryDto,
  CreatePrescriptionDto,
  UpdateConsultationStatusDto,
} from './dto/consultation.dto';

const ALLOWED_TRANSITIONS: Record<ConsultationStatus, ConsultationStatus[]> = {
  SCHEDULED: [
    ConsultationStatus.IN_PROGRESS,
    ConsultationStatus.CANCELLED,
    ConsultationStatus.NO_SHOW,
  ],
  IN_PROGRESS: [ConsultationStatus.COMPLETED, ConsultationStatus.CANCELLED],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

@Injectable()
export class ConsultationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  book(user: AuthUser, dto: BookConsultationDto, key: string, context: AuditContext) {
    return this.idempotency.execute({
      userId: user.id,
      route: 'POST:/v1/bookings',
      key: IdempotencyService.validateKey(key),
      request: dto,
      successStatus: 201,
      handler: async (tx) => {
        const slot = await tx.availabilitySlot.findUnique({
          where: { id: dto.slotId },
          include: { doctor: { include: { user: { select: { status: true } } } } },
        });
        if (!slot) throw new NotFoundException('Availability slot not found');
        if (!slot.doctor.active || slot.doctor.user.status !== UserStatus.ACTIVE) {
          throw new ConflictException('Doctor is not accepting bookings');
        }
        if (slot.startsAt <= new Date()) throw new ConflictException('Slot has already started');

        const claimed = await tx.availabilitySlot.updateMany({
          where: { id: slot.id, status: SlotStatus.AVAILABLE, version: slot.version },
          data: { status: SlotStatus.BOOKED, version: { increment: 1 } },
        });
        if (claimed.count !== 1) throw new ConflictException('Slot is no longer available');

        const consultation = await tx.consultation.create({
          data: {
            patientId: user.id,
            doctorId: slot.doctorId,
            slotId: slot.id,
            reasonEncrypted: this.crypto.encrypt(dto.reason.trim()),
            scheduledStart: slot.startsAt,
            scheduledEnd: slot.endsAt,
            payment: {
              create: {
                amountCents: slot.doctor.consultationFeeCents,
                currency: 'INR',
              },
            },
          },
          include: { payment: true },
        });
        await tx.outboxEvent.create({
          data: {
            aggregateType: 'consultation',
            aggregateId: consultation.id,
            eventType: 'consultation.booked',
            payload: {
              consultationId: consultation.id,
              patientId: user.id,
              doctorId: slot.doctorId,
              scheduledStart: slot.startsAt.toISOString(),
            },
          },
        });
        await this.audit.write(tx, {
          actorId: user.id,
          action: 'consultation.booked',
          resourceType: 'consultation',
          resourceId: consultation.id,
          metadata: { doctorId: slot.doctorId, slotId: slot.id },
          context,
        });
        return this.publicConsultation(consultation);
      },
    });
  }

  async list(user: AuthUser, query: ConsultationQueryDto) {
    const where: Prisma.ConsultationWhereInput = {
      ...this.scopeFor(user),
      status: query.status,
      scheduledStart: {
        gte: query.from ? new Date(query.from) : undefined,
        lte: query.to ? new Date(query.to) : undefined,
      },
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.consultation.findMany({
        where,
        include: {
          doctor: {
            select: { id: true, specialization: true, user: { select: { profile: true } } },
          },
          patient: { select: { profile: true } },
          payment: true,
          prescription: { select: { id: true, createdAt: true } },
        },
        orderBy: { scheduledStart: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.consultation.count({ where }),
    ]);
    return {
      items: items.map((item) => ({
        ...this.publicConsultation(item),
        doctorName: item.doctor.user.profile?.fullName,
        patientName: item.patient.profile?.fullName,
        prescription: item.prescription,
      })),
      page: query.page,
      limit: query.limit,
      total,
    };
  }

  async get(user: AuthUser, id: string, context: AuditContext) {
    const consultation = await this.prisma.consultation.findFirst({
      where: { id, ...this.scopeFor(user) },
      include: {
        doctor: { select: { id: true, specialization: true, user: { select: { profile: true } } } },
        patient: { select: { profile: true } },
        payment: true,
        prescription: true,
      },
    });
    if (!consultation) throw new NotFoundException('Consultation not found');
    await this.prisma.auditLog.create({
      data: {
        actorId: user.id,
        action: 'consultation.viewed',
        resourceType: 'consultation',
        resourceId: consultation.id,
        metadata: { role: user.role },
        ipAddress: context.ipAddress,
        requestId: context.requestId,
      },
    });
    return {
      ...this.publicConsultation(consultation),
      reason: this.crypto.decrypt(consultation.reasonEncrypted),
      clinicalNotes: consultation.clinicalNotesEncrypted
        ? this.crypto.decrypt(consultation.clinicalNotesEncrypted)
        : null,
      doctorName: consultation.doctor.user.profile?.fullName,
      patientName: consultation.patient.profile?.fullName,
      prescription: consultation.prescription
        ? {
            id: consultation.prescription.id,
            medications: JSON.parse(
              this.crypto.decrypt(consultation.prescription.medicationsEncrypted),
            ) as unknown,
            instructions: consultation.prescription.instructionsEncrypted
              ? this.crypto.decrypt(consultation.prescription.instructionsEncrypted)
              : null,
            createdAt: consultation.prescription.createdAt,
          }
        : null,
    };
  }

  async updateStatus(
    user: AuthUser,
    id: string,
    dto: UpdateConsultationStatusDto,
    context: AuditContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.consultation.findFirst({
        where: { id, ...this.scopeFor(user) },
        include: { doctor: true, payment: true },
      });
      if (!current) throw new NotFoundException('Consultation not found');
      if (user.role !== Role.PATIENT && !user.mfa) {
        throw new ForbiddenException('MFA verification is required for clinical updates');
      }
      this.assertCanAct(user, current, dto.status);
      if (current.status === dto.status && current.version === dto.expectedVersion + 1) {
        return {
          id: current.id,
          status: current.status,
          version: current.version,
          updatedAt: current.updatedAt,
        };
      }
      if (
        user.role === Role.PATIENT &&
        (current.status !== ConsultationStatus.SCHEDULED || current.scheduledStart <= new Date())
      ) {
        throw new ForbiddenException('Patients may only cancel a future scheduled consultation');
      }
      if (!ALLOWED_TRANSITIONS[current.status].includes(dto.status)) {
        throw new ConflictException(`Cannot transition ${current.status} to ${dto.status}`);
      }
      const now = new Date();
      if (
        dto.status === ConsultationStatus.IN_PROGRESS &&
        current.scheduledStart.getTime() > now.getTime() + 15 * 60_000
      ) {
        throw new ConflictException('Consultation cannot start more than 15 minutes early');
      }
      if (dto.status === ConsultationStatus.NO_SHOW && current.scheduledEnd > now) {
        throw new ConflictException('Consultation cannot be marked no-show before it ends');
      }
      if (dto.clinicalNotes && user.role !== Role.DOCTOR && user.role !== Role.ADMIN) {
        throw new ForbiddenException('Only a doctor can record clinical notes');
      }

      const changed = await tx.consultation.updateMany({
        where: { id, status: current.status, version: dto.expectedVersion },
        data: {
          status: dto.status,
          version: { increment: 1 },
          clinicalNotesEncrypted: dto.clinicalNotes
            ? this.crypto.encrypt(dto.clinicalNotes)
            : undefined,
        },
      });
      if (changed.count !== 1) {
        throw new ConflictException('Consultation changed; fetch the latest version and retry');
      }

      if (dto.status === ConsultationStatus.CANCELLED && current.scheduledStart > new Date()) {
        await tx.availabilitySlot.update({
          where: { id: current.slotId },
          data: { status: SlotStatus.AVAILABLE, version: { increment: 1 } },
        });
        if (current.payment?.status === PaymentStatus.CAPTURED) {
          await tx.outboxEvent.create({
            data: {
              aggregateType: 'payment',
              aggregateId: current.payment.id,
              eventType: 'payment.refund_requested',
              payload: { paymentId: current.payment.id, consultationId: current.id },
            },
          });
        }
      }

      await tx.outboxEvent.create({
        data: {
          aggregateType: 'consultation',
          aggregateId: id,
          eventType: `consultation.${dto.status.toLowerCase()}`,
          payload: { consultationId: id, status: dto.status },
        },
      });
      await this.audit.write(tx, {
        actorId: user.id,
        action: 'consultation.status_changed',
        resourceType: 'consultation',
        resourceId: id,
        metadata: { from: current.status, to: dto.status },
        context,
      });
      return tx.consultation.findUniqueOrThrow({
        where: { id },
        select: { id: true, status: true, version: true, updatedAt: true },
      });
    });
  }

  async prescribe(
    user: AuthUser,
    consultationId: string,
    dto: CreatePrescriptionDto,
    key: string,
    context: AuditContext,
  ) {
    try {
      return await this.idempotency.execute({
        userId: user.id,
        route: `POST:/v1/consultations/${consultationId}/prescriptions`,
        key: IdempotencyService.validateKey(key),
        request: dto,
        successStatus: 201,
        handler: async (tx) => {
          const consultation = await tx.consultation.findFirst({
            where: { id: consultationId, doctor: { userId: user.id } },
          });
          if (!consultation) throw new NotFoundException('Consultation not found');
          const prescribableStatuses: ConsultationStatus[] = [
            ConsultationStatus.IN_PROGRESS,
            ConsultationStatus.COMPLETED,
          ];
          if (!prescribableStatuses.includes(consultation.status)) {
            throw new ConflictException(
              'Prescription requires an active or completed consultation',
            );
          }
          const existing = await tx.prescription.findUnique({ where: { consultationId } });
          if (existing) throw new ConflictException('A prescription already exists');

          const prescription = await tx.prescription.create({
            data: {
              consultationId,
              doctorId: consultation.doctorId,
              medicationsEncrypted: this.crypto.encrypt(JSON.stringify(dto.medications)),
              instructionsEncrypted: dto.instructions
                ? this.crypto.encrypt(dto.instructions)
                : undefined,
            },
            select: { id: true, consultationId: true, doctorId: true, createdAt: true },
          });
          await tx.outboxEvent.create({
            data: {
              aggregateType: 'prescription',
              aggregateId: prescription.id,
              eventType: 'prescription.issued',
              payload: { prescriptionId: prescription.id, consultationId },
            },
          });
          await this.audit.write(tx, {
            actorId: user.id,
            action: 'prescription.issued',
            resourceType: 'prescription',
            resourceId: prescription.id,
            metadata: { consultationId },
            context,
          });
          return prescription;
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A prescription already exists');
      }
      throw error;
    }
  }

  private scopeFor(user: AuthUser): Prisma.ConsultationWhereInput {
    if (user.role === Role.ADMIN) {
      throw new ForbiddenException('Administrators cannot access clinical records');
    }
    if (user.role === Role.PATIENT) return { patientId: user.id };
    return { doctor: { userId: user.id } };
  }

  private assertCanAct(
    user: AuthUser,
    consultation: {
      patientId: string;
      status: ConsultationStatus;
      scheduledStart: Date;
      doctor: { userId: string };
    },
    next: ConsultationStatus,
  ): void {
    if (user.role === Role.ADMIN) return;
    if (user.role === Role.PATIENT) {
      if (consultation.patientId !== user.id || next !== ConsultationStatus.CANCELLED) {
        throw new ForbiddenException('Patients may only cancel their own consultation');
      }
      return;
    }
    if (consultation.doctor.userId !== user.id) {
      throw new ForbiddenException('Consultation is assigned to another doctor');
    }
  }

  private publicConsultation(consultation: {
    id: string;
    patientId: string;
    doctorId: string;
    slotId: string;
    status: ConsultationStatus;
    scheduledStart: Date;
    scheduledEnd: Date;
    version: number;
    createdAt: Date;
    updatedAt: Date;
    payment?: {
      id: string;
      amountCents: number;
      currency: string;
      status: PaymentStatus;
    } | null;
  }) {
    return {
      id: consultation.id,
      patientId: consultation.patientId,
      doctorId: consultation.doctorId,
      slotId: consultation.slotId,
      status: consultation.status,
      scheduledStart: consultation.scheduledStart,
      scheduledEnd: consultation.scheduledEnd,
      version: consultation.version,
      payment: consultation.payment
        ? {
            id: consultation.payment.id,
            amountCents: consultation.payment.amountCents,
            currency: consultation.payment.currency,
            status: consultation.payment.status,
          }
        : null,
      createdAt: consultation.createdAt,
      updatedAt: consultation.updatedAt,
    };
  }
}
