import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PaymentStatus, Prisma } from '@prisma/client';
import { AuditService } from '../../common/services/audit.service';
import { AuditContext } from '../../common/types/auth-user';
import { PrismaService } from '../../database/prisma.service';
import { UpdatePaymentStatusDto } from './dto/payment.dto';

const PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  PENDING: [PaymentStatus.AUTHORIZED, PaymentStatus.FAILED],
  AUTHORIZED: [PaymentStatus.CAPTURED, PaymentStatus.FAILED],
  CAPTURED: [PaymentStatus.REFUNDED],
  REFUNDED: [],
  FAILED: [],
};

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async updateStatus(
    actorId: string,
    paymentId: string,
    dto: UpdatePaymentStatusDto,
    context: AuditContext,
  ) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const current = await tx.payment.findUnique({ where: { id: paymentId } });
        if (!current) throw new NotFoundException('Payment not found');
        if (current.status === dto.status) {
          if (
            dto.providerReference !== undefined &&
            dto.providerReference !== current.providerReference
          ) {
            throw new ConflictException('Payment status already has another provider reference');
          }
          return current;
        }
        if (!PAYMENT_TRANSITIONS[current.status].includes(dto.status)) {
          throw new ConflictException(`Cannot transition ${current.status} to ${dto.status}`);
        }
        const changed = await tx.payment.updateMany({
          where: { id: paymentId, status: current.status },
          data: { status: dto.status, providerReference: dto.providerReference },
        });
        if (changed.count !== 1) {
          throw new ConflictException('Payment changed; fetch the latest state and retry');
        }
        const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
        await tx.outboxEvent.create({
          data: {
            aggregateType: 'payment',
            aggregateId: payment.id,
            eventType: `payment.${payment.status.toLowerCase()}`,
            payload: { paymentId: payment.id, consultationId: payment.consultationId },
          },
        });
        await this.audit.write(tx, {
          actorId,
          action: 'payment.status_changed',
          resourceType: 'payment',
          resourceId: payment.id,
          metadata: { from: current.status, to: payment.status },
          context,
        });
        return payment;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Provider reference is already assigned to another payment');
      }
      throw error;
    }
  }
}
