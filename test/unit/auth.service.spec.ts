jest.mock('argon2', () => ({
  argon2id: 2,
  hash: jest.fn(),
  verify: jest.fn(),
}));

jest.mock('otplib', () => ({
  authenticator: {
    check: jest.fn(),
    generateSecret: jest.fn(() => 'generated-secret'),
    keyuri: jest.fn(() => 'otpauth://totp/Amrutam'),
  },
}));

import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import { AuditService } from '../../src/common/services/audit.service';
import { CryptoService } from '../../src/common/services/crypto.service';
import { AuditContext } from '../../src/common/types/auth-user';
import { PrismaService } from '../../src/database/prisma.service';
import { AuthService } from '../../src/modules/auth/auth.service';

const verifyPassword = argon2.verify as jest.MockedFunction<typeof argon2.verify>;
const hashPassword = argon2.hash as jest.MockedFunction<typeof argon2.hash>;
const checkTotp = authenticator.check as jest.MockedFunction<typeof authenticator.check>;
const context: AuditContext = { requestId: 'auth-request', ipAddress: '127.0.0.1' };

const activeUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'patient@example.test',
  passwordHash: 'argon-hash',
  role: Role.PATIENT,
  status: UserStatus.ACTIVE,
  mfaEnabled: false,
  mfaSecretEncrypted: null as string | null,
  mfaPendingSecretEncrypted: null as string | null,
  mfaLastUsedStep: null as number | null,
};

function createHarness() {
  const tx = {
    refreshToken: {
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: {
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: jest.fn() },
  };
  const prisma = {
    user: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
    $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
  };
  const jwt = { signAsync: jest.fn().mockResolvedValue('signed-access-token') };
  const config = {
    get: jest.fn((name: string, fallback: unknown) => {
      if (name === 'JWT_ACCESS_TTL_SECONDS') return 600;
      if (name === 'REFRESH_TOKEN_TTL_DAYS') return 7;
      return fallback;
    }),
  };
  const crypto = {
    encrypt: jest.fn((value: string) => `encrypted:${value}`),
    decrypt: jest.fn(() => 'totp-secret'),
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const service = new AuthService(
    prisma as unknown as PrismaService,
    jwt as unknown as JwtService,
    config as unknown as ConfigService,
    crypto as unknown as CryptoService,
    audit as unknown as AuditService,
  );
  return { service, prisma, tx, jwt, crypto, audit };
}

describe('AuthService.login', () => {
  beforeEach(() => {
    verifyPassword.mockReset();
    hashPassword.mockReset();
    checkTotp.mockReset();
  });

  it('normalizes email, verifies the password, and issues an audited token pair', async () => {
    const { service, prisma, tx, jwt, audit } = createHarness();
    prisma.user.findUnique.mockResolvedValue(activeUser);
    verifyPassword.mockResolvedValue(true);

    const result = await service.login(
      { email: '  PATIENT@EXAMPLE.TEST ', password: 'correct password' },
      context,
    );

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'patient@example.test' },
    });
    expect(verifyPassword).toHaveBeenCalledWith('argon-hash', 'correct password');
    expect(jwt.signAsync).toHaveBeenCalledWith(
      { sub: activeUser.id, email: activeUser.email, role: Role.PATIENT, mfa: false },
      { expiresIn: 600 },
    );
    expect(result).toEqual({
      accessToken: 'signed-access-token',
      expiresIn: 600,
      refreshToken: expect.any(String),
      tokenType: 'Bearer',
    });
    expect(result.refreshToken).toHaveLength(64);
    expect(tx.refreshToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: activeUser.id,
        tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        mfaVerified: false,
        expiresAt: expect.any(Date),
      }),
    });
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'auth.login_succeeded', actorId: activeUser.id, context }),
    );
  });

  it('performs an expensive dummy hash for an unknown email before rejecting it', async () => {
    const { service, prisma } = createHarness();
    prisma.user.findUnique.mockResolvedValue(null);
    hashPassword.mockResolvedValue('dummy-hash');

    await expect(
      service.login({ email: 'missing@example.test', password: 'guess' }, context),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(hashPassword).toHaveBeenCalledWith(
      'guess',
      expect.objectContaining({ memoryCost: 19_456, timeCost: 2 }),
    );
  });

  it.each([
    ['bad password', { ...activeUser }, false],
    ['suspended account', { ...activeUser, status: UserStatus.SUSPENDED }, true],
  ])('rejects a %s without issuing tokens', async (_label, record, passwordValid) => {
    const { service, prisma, jwt } = createHarness();
    prisma.user.findUnique.mockResolvedValue(record);
    verifyPassword.mockResolvedValue(passwordValid);

    await expect(
      service.login({ email: activeUser.email, password: 'guess' }, context),
    ).rejects.toThrow('Invalid credentials');
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });

  it('requires and verifies TOTP before putting the MFA claim in the access token', async () => {
    const mfaUser = {
      ...activeUser,
      role: Role.DOCTOR,
      mfaEnabled: true,
      mfaSecretEncrypted: 'encrypted-secret',
    };
    const { service, prisma, jwt, crypto } = createHarness();
    prisma.user.findUnique.mockResolvedValue(mfaUser);
    verifyPassword.mockResolvedValue(true);

    await expect(
      service.login({ email: mfaUser.email, password: 'correct password' }, context),
    ).rejects.toThrow('MFA code required');

    checkTotp.mockReturnValue(false);
    await expect(
      service.login(
        { email: mfaUser.email, password: 'correct password', totpCode: '000000' },
        context,
      ),
    ).rejects.toThrow('Invalid credentials');

    checkTotp.mockReturnValue(true);
    await expect(
      service.login(
        { email: mfaUser.email, password: 'correct password', totpCode: '123456' },
        context,
      ),
    ).resolves.toEqual(expect.objectContaining({ accessToken: 'signed-access-token' }));
    expect(crypto.decrypt).toHaveBeenCalledWith('encrypted-secret');
    expect(jwt.signAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ sub: mfaUser.id, role: Role.DOCTOR, mfa: true }),
      { expiresIn: 600 },
    );
  });
});

describe('AuthService refresh-token rotation', () => {
  it('rotates a valid token and links the old record to the replacement hash', async () => {
    const { service, tx } = createHarness();
    tx.refreshToken.findUnique.mockResolvedValue({
      id: 'refresh-1',
      userId: activeUser.id,
      tokenHash: 'stored-hash',
      mfaVerified: false,
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      user: activeUser,
    });

    const result = await service.refresh({ refreshToken: 'presented-token' }, context);

    expect(result.accessToken).toBe('signed-access-token');
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { id: 'refresh-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(tx.refreshToken.update).toHaveBeenCalledWith({
      where: { id: 'refresh-1' },
      data: { replacedBy: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
  });

  it('detects reuse and attempts to revoke the user token family', async () => {
    const { service, tx, audit } = createHarness();
    tx.refreshToken.findUnique.mockResolvedValue({
      id: 'refresh-1',
      userId: activeUser.id,
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: new Date(),
      user: activeUser,
    });

    await expect(service.refresh({ refreshToken: 'reused-token' }, context)).rejects.toThrow(
      'Refresh token reuse detected',
    );
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: activeUser.id, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'auth.refresh_reuse_detected', actorId: activeUser.id }),
    );
  });
});
