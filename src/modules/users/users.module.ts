import { Module } from '@nestjs/common';
import { AdminUsersController, UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController, AdminUsersController],
  providers: [UsersService],
})
export class UsersModule {}
