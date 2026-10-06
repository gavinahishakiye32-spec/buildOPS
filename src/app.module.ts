import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { SoftDeletePurgeService } from './common/soft-delete-purge.service.js';
import { AuthModule } from './auth/auth.module.js';
import { ENTITIES } from './common/entities.js';
import { MIGRATIONS } from './database/migrations.js';
import { PlanModule } from './plan/plan.module.js';
import { PlanLimitModule } from './plan-limit/plan-limit.module.js';
import { SubscriptionModule } from './subscription/subscription.module.js';
import { BillingModule } from './billing/billing.module.js';

import { OrganizationModule } from './organization/organization.module.js';
import { RoleModule } from './role/role.module.js';
import { InvitationModule } from './invitation/invitation.module.js';
import { TeamModule } from './team/team.module.js';
import { ClientModule } from './client/client.module.js';
import { ProjectModule } from './project/project.module.js';
import { BadgeModule } from './badge/badge.module.js';
import { TaskModule } from './task/task.module.js';
import { SubtaskModule } from './subtask/subtask.module.js';
import { TimeEntryModule } from './time-entry/time-entry.module.js';
import { TimeComplexityModule } from './time-complexity/time-complexity.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { SettingsModule } from './settings/settings.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.get<string>('DB_HOST', 'localhost'),
        port: config.get<number>('DB_PORT', 5432),
        username: config.get<string>('DB_USERNAME', 'postgres'),
        password: config.get<string>('DB_PASSWORD') || 'postgres',
        database: config.get<string>('DB_DATABASE', 'ops'),
        entities: ENTITIES,
        // The schema comes from versioned migrations, never from `synchronize`:
        // synchronizing derives DDL from the entities on every boot, so a
        // renamed column silently became a dropped column and no schema change
        // could be reviewed before it touched real data. `migrationsRun` applies
        // pending migrations at boot, which is what lets the e2e suites keep
        // truncating a database they do not build.
        migrationsRun: true,
        migrations: MIGRATIONS,
        migrationsTableName: 'migrations',
        synchronize: false,
      }),
      inject: [ConfigService],
    }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => [
        {
          name: 'default',
          ttl: Number(config.get<string>('THROTTLE_TTL', '60000')),
          limit: Number(config.get<string>('THROTTLE_LIMIT', '300')),
        },
        {
          name: 'auth',
          ttl: Number(config.get<string>('AUTH_THROTTLE_TTL', '900000')),
          limit: Number(config.get<string>('AUTH_THROTTLE_LIMIT', '10')),
        },
      ],
      inject: [ConfigService],
    }),
    AuthModule,
    BillingModule,
    PlanModule,
    PlanLimitModule,
    SubscriptionModule,
    OrganizationModule,
    RoleModule,
    InvitationModule,
    TeamModule,
    ClientModule,
    ProjectModule,
    BadgeModule,
    TaskModule,
    SubtaskModule,
    TimeEntryModule,
    TimeComplexityModule,
    DashboardModule,
    SettingsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Retention for soft-deleted rows (spec §22). Lives in the root module
    // because it spans every soft-deletable table rather than belonging to any
    // one of them.
    SoftDeletePurgeService,
    // Global rate limiting (spec §17): `default` for the API surface and the
    // stricter `auth` bucket enforced with @Throttle on credential routes.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
