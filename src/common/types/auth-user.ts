import { Role } from '@prisma/client';

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  mfa: boolean;
}

export interface AuditContext {
  requestId: string;
  ipAddress?: string;
}
