import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Organization } from '../organization/organization.entity.js';
import { PlanModule } from '../plan/plan.module.js';
import { Project } from '../project/project.entity.js';
import { User } from '../user/user.entity.js';
import { SubscriptionController } from './subscription.controller.js';
import { Subscription } from './subscription.entity.js';
import { SubscriptionService } from './subscription.service.js';
import { AuthorizationModule } from '../auth/authorization.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    TypeOrmModule.forFeature([Subscription, Organization, Project, User]),
    PlanModule,
  ],
  controllers: [SubscriptionController],
  providers: [SubscriptionService],
  exports: [SubscriptionService],
})
export class SubscriptionModule {}
