import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../auth/authorization.module.js';
import { Notification } from './notification.entity.js';
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
    TypeOrmModule.forFeature([Notification]),
  ],
  controllers: [NotificationController],
  providers: [NotificationService],
  // Exported because `SubtaskModule` writes them: assigning work is what
  // rings the bell, and that code lives one module over.
  exports: [NotificationService],
})
export class NotificationModule {}
