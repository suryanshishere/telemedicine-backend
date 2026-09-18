import { Module } from '@nestjs/common';
import { BookingsController, ConsultationsController } from './consultations.controller';
import { ConsultationsService } from './consultations.service';

@Module({
  controllers: [BookingsController, ConsultationsController],
  providers: [ConsultationsService],
  exports: [ConsultationsService],
})
export class ConsultationsModule {}
