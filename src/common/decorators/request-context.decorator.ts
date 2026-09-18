import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { AuditContext } from '../types/auth-user';

export const RequestContext = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuditContext => {
    const request = context.switchToHttp().getRequest<Request & { id?: string }>();
    return {
      requestId: request.id ?? request.header('x-request-id') ?? 'unknown',
      ipAddress: request.ip,
    };
  },
);
