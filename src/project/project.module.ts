import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Client } from '../client/client.entity.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { ProjectController } from './project.controller.js';
import { Project } from './project.entity.js';
import { ProjectService } from './project.service.js';
import { AuthorizationModule } from '../auth/authorization.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [
    AuthModule,
    AuthorizationModule,TypeOrmModule.forFeature([Project, Client]), TenantModule],
  controllers: [ProjectController],
  providers: [ProjectService],
  exports: [ProjectService, TypeOrmModule],
})
export class ProjectModule {}