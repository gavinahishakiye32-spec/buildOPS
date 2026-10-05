import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Organization } from '../organization/organization.entity.js';
import { PlanModule } from '../plan/plan.module.js';
import { Project } from '../project/project.entity.js';
import { Role } from '../role/role.entity.js';
import { Subscription } from '../subscription/subscription.entity.js';
import { PlanLimitService } from './plan-limit.service.js';

/**
 * Plan-limit enforcement and tenant resolution. It only imports entities, so the
 * feature modules that must enforce capacity can import it without the module
 * cycle that `SubscriptionModule` would introduce through `AuthorizationModule`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Subscription, Organization, Project, Role]),
    PlanModule,
  ],
  providers: [PlanLimitService],
  exports: [PlanLimitService],
})
export class PlanLimitModule {}
