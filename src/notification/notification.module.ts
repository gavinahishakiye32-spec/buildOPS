import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../auth/authorization.module.js';
import { MailModule } from '../mail/mail.module.js';
import { Role } from '../role/role.entity.js';
import { User } from '../user/user.entity.js';
import { Notification } from './notification.entity.js';
import { NotificationEmail } from './notification-email.entity.js';
import { NotificationEmailService } from './notification-email.service.js';
import { NotificationController } from './notification.controller.js';
import { NotificationService } from './notification.service.js';

@Module({
  imports: [
    AuthModule,
    // `@Protected()` applies `PermissionsGuard`, which resolves the caller's
    // membership. The routes here gate on nothing of their own -- a
    // notification is addressed to its recipient and to nobody else -- but the
    // guard still has to be constructible.
    AuthorizationModule,
    // Emailing the recipient is the other half of notifying them, so the mail
    // transport is part of this module rather than pulled in by each caller.
    MailModule,
    // `Role` is here for `broadcast`, which resolves its audience from the
    // members' role permissions rather than from a hard-coded name. `User` is
    // read for the recipient's address when *emailing* a notification.
    // `NotificationEmail` is the outbox the worker drains.
    TypeOrmModule.forFeature([Notification, Role, User, NotificationEmail]),
  ],
  controllers: [NotificationController],
  providers: [NotificationService, NotificationEmailService],
  // Exported because `SubtaskModule` writes them: assigning work is what
  // rings the bell, and that code lives one module over. The email outbox is
  // exported so e2e tests can drive a delivery pass without the background
  // worker (which is disabled in tests).
  exports: [NotificationService, NotificationEmailService],
})
export class NotificationModule {}
