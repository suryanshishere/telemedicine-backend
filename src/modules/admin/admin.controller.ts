import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { RequireMfa } from '../../common/decorators/require-mfa.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AdminService } from './admin.service';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@RequireMfa()
@Controller('v1/admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('analytics')
  analytics(@Query() query: AnalyticsQueryDto) {
    return this.admin.analytics(query);
  }
}
