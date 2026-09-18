import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Role, UserStatus } from '@prisma/client';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../database/prisma.service';

interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
  mfa: boolean;
  iat: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
      ignoreExpiration: false,
      algorithms: ['HS256'],
      issuer: 'amrutam-api',
      audience: 'amrutam-clients',
    });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        mfaEnabled: true,
        passwordChangedAt: true,
      },
    });
    if (
      !user ||
      user.status !== UserStatus.ACTIVE ||
      Math.floor(user.passwordChangedAt.getTime() / 1_000) > payload.iat
    ) {
      throw new UnauthorizedException();
    }
    return { id: user.id, email: user.email, role: user.role, mfa: user.mfaEnabled && payload.mfa };
  }
}
