import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { REQUIRE_MFA_KEY } from '../decorators/require-mfa.decorator';
import { AuthUser } from '../types/auth-user';

@Injectable()
export class MfaGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(REQUIRE_MFA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    if (!request.user?.mfa) throw new ForbiddenException('MFA verification is required');
    return true;
  }
}
