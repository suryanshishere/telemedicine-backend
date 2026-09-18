import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, Role, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import { createHash, randomBytes } from 'node:crypto';
import { AuditService } from '../../common/services/audit.service';
import { CryptoService } from '../../common/services/crypto.service';
import { AuditContext, AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../database/prisma.service';
import { LoginDto, RefreshDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

export interface TokenPair {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  tokenType: 'Bearer';
}

@Injectable()
export class AuthService {
  private readonly accessTtl: number;
  private readonly refreshTtlDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {
    this.accessTtl = config.get<number>('JWT_ACCESS_TTL_SECONDS', 900);
    this.refreshTtlDays = config.get<number>('REFRESH_TOKEN_TTL_DAYS', 30);
  }

  async register(dto: RegisterDto, context: AuditContext) {
    const email = dto.email.trim().toLowerCase();
    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email,
            passwordHash,
            role: dto.role,
            profile: {
              create: {
                fullName: dto.fullName.trim(),
                phoneEncrypted: dto.phone ? this.crypto.encrypt(dto.phone) : undefined,
              },
            },
            doctor:
              dto.role === Role.DOCTOR
                ? {
                    create: {
                      specialization: dto.specialization!.trim(),
                      licenseNumberEncrypted: this.crypto.encrypt(dto.licenseNumber!),
                      consultationFeeCents: dto.consultationFeeCents!,
                      active: false,
                    },
                  }
                : undefined,
          },
          include: { profile: true, doctor: true },
        });
        await this.audit.write(tx, {
          actorId: created.id,
          action: 'user.registered',
          resourceType: 'user',
          resourceId: created.id,
          metadata: { role: created.role },
          context,
        });
        return created;
      });
      return this.safeUser(user);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('An account with that email already exists');
      }
      throw error;
    }
  }

  async login(dto: LoginDto, context: AuditContext): Promise<TokenPair> {
    const email = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      await argon2.hash(dto.password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2 });
      throw new UnauthorizedException('Invalid credentials');
    }
    const validPassword = await argon2.verify(user.passwordHash, dto.password);
    if (!validPassword || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Invalid credentials');
    }
    let mfaStep: number | undefined;
    if (user.mfaEnabled) {
      if (!dto.totpCode || !user.mfaSecretEncrypted) {
        throw new UnauthorizedException('MFA code required');
      }
      const secret = this.crypto.decrypt(user.mfaSecretEncrypted);
      if (!authenticator.check(dto.totpCode, secret)) {
        throw new UnauthorizedException('Invalid credentials');
      }
      mfaStep = currentTotpStep();
    }

    return this.prisma.$transaction(async (tx) => {
      if (mfaStep !== undefined) {
        const consumed = await tx.user.updateMany({
          where: {
            id: user.id,
            mfaEnabled: true,
            status: UserStatus.ACTIVE,
            OR: [{ mfaLastUsedStep: null }, { mfaLastUsedStep: { lt: mfaStep } }],
          },
          data: { mfaLastUsedStep: mfaStep },
        });
        if (consumed.count !== 1) throw new UnauthorizedException('Invalid credentials');
      }
      const tokens = await this.issueTokens(tx, this.toAuthUser(user));
      await this.audit.write(tx, {
        actorId: user.id,
        action: 'auth.login_succeeded',
        resourceType: 'user',
        resourceId: user.id,
        context,
      });
      return tokens;
    });
  }

  async refresh(dto: RefreshDto, context: AuditContext): Promise<TokenPair> {
    const tokenHash = hashToken(dto.refreshToken);
    const result = await this.prisma.$transaction(async (tx) => {
      const stored = await tx.refreshToken.findUnique({
        where: { tokenHash },
        include: { user: true },
      });
      if (!stored || stored.expiresAt <= new Date() || stored.user.status !== UserStatus.ACTIVE) {
        throw new UnauthorizedException('Invalid refresh token');
      }
      if (stored.revokedAt) {
        await tx.refreshToken.updateMany({
          where: { userId: stored.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await this.audit.write(tx, {
          actorId: stored.userId,
          action: 'auth.refresh_reuse_detected',
          resourceType: 'user',
          resourceId: stored.userId,
          context,
        });
        return null;
      }

      const claimed = await tx.refreshToken.updateMany({
        where: { id: stored.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (claimed.count !== 1) {
        await tx.refreshToken.updateMany({
          where: { userId: stored.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await this.audit.write(tx, {
          actorId: stored.userId,
          action: 'auth.refresh_reuse_detected',
          resourceType: 'user',
          resourceId: stored.userId,
          context,
        });
        return null;
      }

      const tokens = await this.issueTokens(tx, {
        ...this.toAuthUser(stored.user),
        mfa: stored.mfaVerified && stored.user.mfaEnabled,
      });
      await tx.refreshToken.update({
        where: { id: stored.id },
        data: { replacedBy: hashToken(tokens.refreshToken) },
      });
      return tokens;
    });
    if (!result) throw new UnauthorizedException('Refresh token reuse detected');
    return result;
  }

  async logout(userId: string, dto: RefreshDto, context: AuditContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.refreshToken.updateMany({
        where: { userId, tokenHash: hashToken(dto.refreshToken), revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.write(tx, {
        actorId: userId,
        action: 'auth.logout',
        resourceType: 'user',
        resourceId: userId,
        context,
      });
    });
  }

  async setupMfa(user: AuthUser, context: AuditContext) {
    const existing = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (existing.mfaEnabled && !user.mfa) {
      throw new ForbiddenException('Current MFA verification is required to reset MFA');
    }
    const secret = authenticator.generateSecret();
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          mfaPendingSecretEncrypted: this.crypto.encrypt(secret),
        },
      });
      await this.audit.write(tx, {
        actorId: user.id,
        action: 'auth.mfa_setup_started',
        resourceType: 'user',
        resourceId: user.id,
        context,
      });
    });
    return {
      secret,
      otpauthUrl: authenticator.keyuri(user.email, 'Amrutam Telemedicine', secret),
    };
  }

  async verifyMfa(user: AuthUser, code: string, context: AuditContext): Promise<TokenPair> {
    const record = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!record.mfaPendingSecretEncrypted) throw new ConflictException('Start MFA setup first');
    const secret = this.crypto.decrypt(record.mfaPendingSecretEncrypted);
    if (!authenticator.check(code, secret)) throw new UnauthorizedException('Invalid MFA code');
    const mfaStep = currentTotpStep();

    return this.prisma.$transaction(async (tx) => {
      const consumed = await tx.user.updateMany({
        where: {
          id: user.id,
          mfaPendingSecretEncrypted: record.mfaPendingSecretEncrypted,
        },
        data: {
          mfaEnabled: true,
          mfaSecretEncrypted: record.mfaPendingSecretEncrypted,
          mfaPendingSecretEncrypted: null,
          mfaLastUsedStep: mfaStep,
        },
      });
      if (consumed.count !== 1) throw new UnauthorizedException('MFA code was already used');
      await tx.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.write(tx, {
        actorId: user.id,
        action: 'auth.mfa_enabled',
        resourceType: 'user',
        resourceId: user.id,
        context,
      });
      return this.issueTokens(tx, { ...user, mfa: true });
    });
  }

  private async issueTokens(tx: Prisma.TransactionClient, user: AuthUser): Promise<TokenPair> {
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, email: user.email, role: user.role, mfa: user.mfa },
      { expiresIn: this.accessTtl },
    );
    const refreshToken = randomBytes(48).toString('base64url');
    await tx.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        mfaVerified: user.mfa,
        expiresAt: new Date(Date.now() + this.refreshTtlDays * 86_400_000),
      },
    });
    return { accessToken, expiresIn: this.accessTtl, refreshToken, tokenType: 'Bearer' };
  }

  private toAuthUser(user: {
    id: string;
    email: string;
    role: Role;
    mfaEnabled: boolean;
  }): AuthUser {
    return { id: user.id, email: user.email, role: user.role, mfa: user.mfaEnabled };
  }

  private safeUser(user: {
    id: string;
    email: string;
    role: Role;
    status: UserStatus;
    mfaEnabled: boolean;
    createdAt: Date;
    profile: { fullName: string } | null;
    doctor: {
      id: string;
      specialization: string;
      consultationFeeCents: number;
      active: boolean;
    } | null;
  }) {
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      mfaEnabled: user.mfaEnabled,
      fullName: user.profile?.fullName,
      doctor: user.doctor,
      createdAt: user.createdAt,
    };
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function currentTotpStep(): number {
  return Math.floor(Date.now() / 30_000);
}
