import {
  Body,
  Controller,
  Get,
  Headers,
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
import { RequireMfa } from '../../common/decorators/require-mfa.decorator';
import { RequestContext } from '../../common/decorators/request-context.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuditContext, AuthUser } from '../../common/types/auth-user';
import {
  BookConsultationDto,
  ConsultationQueryDto,
  CreatePrescriptionDto,
  UpdateConsultationStatusDto,
} from './dto/consultation.dto';
import { ConsultationsService } from './consultations.service';

@ApiTags('bookings')
@ApiBearerAuth()
@Controller('v1/bookings')
export class BookingsController {
  constructor(private readonly consultations: ConsultationsService) {}

  @Roles(Role.PATIENT)
  @Post()
  async book(
    @CurrentUser() user: AuthUser,
    @Body() dto: BookConsultationDto,
    @Headers('idempotency-key') key: string,
    @RequestContext() context: AuditContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.consultations.book(user, dto, key, context);
    response.status(result.statusCode).setHeader('Idempotency-Replayed', String(result.replayed));
    return result.value;
  }
}

@ApiTags('consultations')
@ApiBearerAuth()
@Roles(Role.PATIENT, Role.DOCTOR)
@Controller('v1/consultations')
export class ConsultationsController {
  constructor(private readonly consultations: ConsultationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: ConsultationQueryDto) {
    return this.consultations.list(user, query);
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @RequestContext() context: AuditContext,
  ) {
    return this.consultations.get(user, id, context);
  }

  @Patch(':id/status')
  updateStatus(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateConsultationStatusDto,
    @RequestContext() context: AuditContext,
  ) {
    return this.consultations.updateStatus(user, id, dto, context);
  }

  @Roles(Role.DOCTOR)
  @RequireMfa()
  @Post(':id/prescriptions')
  async prescribe(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePrescriptionDto,
    @Headers('idempotency-key') key: string,
    @RequestContext() context: AuditContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.consultations.prescribe(user, id, dto, key, context);
    response.status(result.statusCode).setHeader('Idempotency-Replayed', String(result.replayed));
    return result.value;
  }
}
