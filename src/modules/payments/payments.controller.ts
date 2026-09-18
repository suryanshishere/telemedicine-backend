import { Body, Controller, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireMfa } from '../../common/decorators/require-mfa.decorator';
import { RequestContext } from '../../common/decorators/request-context.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuditContext, AuthUser } from '../../common/types/auth-user';
import { UpdatePaymentStatusDto } from './dto/payment.dto';
import { PaymentsService } from './payments.service';

@ApiTags('payments')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@RequireMfa()
@Controller('v1/admin/payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Patch(':id/status')
  updateStatus(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePaymentStatusDto,
    @RequestContext() context: AuditContext,
  ) {
    return this.payments.updateStatus(user.id, id, dto, context);
  }
}
