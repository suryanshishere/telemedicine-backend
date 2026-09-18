import { Module } from '@nestjs/common';
import { AdminDoctorsController, DoctorsController } from './doctors.controller';
import { DoctorsService } from './doctors.service';

@Module({
  controllers: [DoctorsController, AdminDoctorsController],
  providers: [DoctorsService],
  exports: [DoctorsService],
})
export class DoctorsModule {}
