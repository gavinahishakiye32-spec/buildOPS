import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../auth/authorization.module.js';
import { MailModule } from '../mail/mail.module.js';
import { RoleModule } from '../role/role.module.js';
import { User } from '../user/user.entity.js';
import { UserSettings } from '../settings/user-settings.entity.js';
import { NotificationController } from './notification.controller.js';
import { Notification } from './notification.entity.js';
import { NotificationService } from './notification.service.js';

@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    MailModule,
    // The broadcast audience (owner + project managers) is looked up through
    // the roles table, which RoleModule exposes.
    RoleModule,
    // User and UserSettings are read directly (the email preference and the
    // recipient's address) rather than through their modules, so this module
    // stays a leaf the delivery services can import without a cycle.
    TypeOrmModule.forFeature([Notification, User, UserSettings]),
  ],
  controllers: [NotificationController],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}