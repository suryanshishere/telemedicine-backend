import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { RequireMfa } from '../../common/decorators/require-mfa.decorator';
import { RequestContext } from '../../common/decorators/request-context.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuditContext, AuthUser } from '../../common/types/auth-user';
import {
  AvailabilityQueryDto,
  CreateAvailabilityDto,
  DoctorSearchDto,
  UpdateDoctorActivationDto,
} from './dto/doctor.dto';
import { DoctorsService } from './doctors.service';

@ApiTags('doctors')
@Controller('v1/doctors')
export class DoctorsController {
  constructor(private readonly doctors: DoctorsService) {}

  @Public()
  @Get()
  search(@Query() query: DoctorSearchDto) {
    return this.doctors.search(query);
  }

  @Public()
  @Get(':id/availability')
  availability(@Param('id', ParseUUIDPipe) id: string, @Query() query: AvailabilityQueryDto) {
    return this.doctors.availability(id, query);
  }

  @ApiBearerAuth()
  @Roles(Role.DOCTOR)
  @RequireMfa()
  @Post('me/availability')
  async createAvailability(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateAvailabilityDto,
    @Headers('idempotency-key') key: string,
    @RequestContext() context: AuditContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.doctors.createAvailability(user, dto, key, context);
    response.status(result.statusCode).setHeader('Idempotency-Replayed', String(result.replayed));
    return result.value;
  }

  @ApiBearerAuth()
  @Roles(Role.DOCTOR)
  @RequireMfa()
  @HttpCode(200)
  @Patch('me/availability/:id/block')
  blockAvailability(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @RequestContext() context: AuditContext,
  ) {
    return this.doctors.blockAvailability(user, id, context);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@RequireMfa()
@Controller('v1/admin/doctors')
export class AdminDoctorsController {
  constructor(private readonly doctors: DoctorsService) {}

  @Patch(':id/activation')
  setActive(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDoctorActivationDto,
    @RequestContext() context: AuditContext,
  ) {
    return this.doctors.setActive(actor.id, id, dto.active, context);
  }
}
