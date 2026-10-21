import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthorizationModule } from '../auth/authorization.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { User } from '../user/user.entity.js';
import { ActivityContextInterceptor } from './activity-context.interceptor.js';
import { ActivityEvent } from './activity.entity.js';
import { ActivityController } from './activity.controller.js';
import { ActivityService } from './activity.service.js';

/**
 * Records and reports the organization's activity trail (spec §21).
 *
 * `ActivityService` is exported because every feature module writes events
 * through it. `ActivityContextInterceptor` is exported too: `AppModule`
 * registers it as the single global `APP_INTERCEPTOR`, and declaring the
 * provider here — next to the service that reads the context — keeps the two
 * halves of the ambient-actor mechanism in one place.
 *
 * `RoleModule` is deliberately not imported: the interceptor only reads what
 * `PermissionsGuard` already put on the request, and importing the membership
 * resolver here would close a module cycle (RoleModule → ActivityModule → RoleModule)
 * for no benefit.
 */
@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    TypeOrmModule.forFeature([ActivityEvent, User]),
  ],
  controllers: [ActivityController],
  providers: [ActivityService, ActivityContextInterceptor],
  exports: [ActivityService, ActivityContextInterceptor],
})
export class ActivityModule {}
