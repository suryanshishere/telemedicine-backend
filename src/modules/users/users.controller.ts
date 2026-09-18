import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireMfa } from '../../common/decorators/require-mfa.decorator';
import { RequestContext } from '../../common/decorators/request-context.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuditContext, AuthUser } from '../../common/types/auth-user';
import {
  AdminUsersQueryDto,
  AuditLogQueryDto,
  UpdateUserStatusDto,
} from './dto/admin-users-query.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller('v1/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.users.me(user.id);
  }

  @Patch('me')
  updateMe(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateProfileDto,
    @RequestContext() context: AuditContext,
  ) {
    return this.users.updateProfile(user.id, dto, context);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@RequireMfa()
@Controller('v1/admin')
export class AdminUsersController {
  constructor(private readonly users: UsersService) {}

  @Get('users')
  list(@Query() query: AdminUsersQueryDto) {
    return this.users.list(query);
  }

  @Patch('users/:id/status')
  updateStatus(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserStatusDto,
    @RequestContext() context: AuditContext,
  ) {
    return this.users.updateStatus(actor.id, id, dto.status, context);
  }

  @Get('audit-logs')
  auditLogs(@Query() query: AuditLogQueryDto) {
    return this.users.auditLogs(query);
  }
}
