import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { ENTITIES } from './common/entities.js';
import { isProduction } from './common/env.js';
import { PlanModule } from './plan/plan.module.js';
import { SubscriptionModule } from './subscription/subscription.module.js';

import { OrganizationModule } from './organization/organization.module.js';
import { RoleModule } from './role/role.module.js';
import { TeamModule } from './team/team.module.js';
import { ClientModule } from './client/client.module.js';
import { ProjectModule } from './project/project.module.js';
import { BadgeModule } from './badge/badge.module.js';
import { TaskModule } from './task/task.module.js';
import { SubtaskModule } from './subtask/subtask.module.js';
import { TimeEntryModule } from './time-entry/time-entry.module.js';
import { TimeComplexityModule } from './time-complexity/time-complexity.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';

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
        // Schema synchronization is a development convenience only: it derives
        // tables from the entities and can drop columns on rename. Production
        // uses the migrations/schema in schema.sql instead.
        synchronize: !isProduction(config),
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
    PlanModule,
    SubscriptionModule,
    OrganizationModule,
    RoleModule,
    TeamModule,
    ClientModule,
    ProjectModule,
    BadgeModule,
    TaskModule,
    SubtaskModule,
    TimeEntryModule,
    TimeComplexityModule,
    DashboardModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Global rate limiting (spec §17): `default` for the API surface and the
    // stricter `auth` bucket enforced with @Throttle on credential routes.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
