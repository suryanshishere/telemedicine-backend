import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { MfaGuard } from '../../src/common/guards/mfa.guard';
import { RolesGuard } from '../../src/common/guards/roles.guard';
import { AuthUser } from '../../src/common/types/auth-user';

const patient: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'patient@example.test',
  role: Role.PATIENT,
  mfa: false,
};

function httpContext(user?: AuthUser): ExecutionContext {
  return {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: jest.fn(() => ({
      getRequest: jest.fn(() => ({ user })),
    })),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  it('allows routes without role metadata', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) };
    const guard = new RolesGuard(reflector as unknown as Reflector);

    expect(guard.canActivate(httpContext())).toBe(true);
  });

  it('allows an included role and denies a missing or non-included role', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue([Role.PATIENT]) };
    const guard = new RolesGuard(reflector as unknown as Reflector);

    expect(guard.canActivate(httpContext(patient))).toBe(true);
    expect(guard.canActivate(httpContext({ ...patient, role: Role.DOCTOR }))).toBe(false);
    expect(guard.canActivate(httpContext())).toBe(false);
  });
});

describe('MfaGuard', () => {
  it('allows routes that do not require MFA', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    const guard = new MfaGuard(reflector as unknown as Reflector);

    expect(guard.canActivate(httpContext())).toBe(true);
  });

  it('allows an MFA-authenticated principal', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(true) };
    const guard = new MfaGuard(reflector as unknown as Reflector);

    expect(guard.canActivate(httpContext({ ...patient, mfa: true }))).toBe(true);
  });

  it('throws a clear forbidden response when MFA proof is absent', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(true) };
    const guard = new MfaGuard(reflector as unknown as Reflector);

    expect(() => guard.canActivate(httpContext(patient))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(httpContext())).toThrow('MFA verification is required');
  });
});
