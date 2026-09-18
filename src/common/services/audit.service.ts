import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditContext } from '../types/auth-user';

export interface AuditEvent {
  actorId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  metadata?: Prisma.InputJsonValue;
  context: AuditContext;
}

@Injectable()
export class AuditService {
  async write(tx: Prisma.TransactionClient, event: AuditEvent): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorId: event.actorId,
        action: event.action,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        metadata: event.metadata ?? {},
        ipAddress: event.context.ipAddress,
        requestId: event.context.requestId,
      },
    });
  }
}
