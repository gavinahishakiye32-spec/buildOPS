import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Organization } from '../organization/organization.entity.js';
import { PlanModule } from '../plan/plan.module.js';
import { Project } from '../project/project.entity.js';
import { User } from '../user/user.entity.js';
import { TenantController } from './tenant.controller.js';
import { Tenant } from './tenant.entity.js';
import { TenantService } from './tenant.service.js';
import { AuthorizationModule } from '../auth/authorization.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    TypeOrmModule.forFeature([Tenant, Organization, Project, User]),
    PlanModule,
  ],
  controllers: [TenantController],
  providers: [TenantService],
  exports: [TenantService],
})
export class TenantModule {}