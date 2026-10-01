import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Badge } from '../badge/badge.entity.js';
import { Project } from '../project/project.entity.js';
import { Team } from '../team/team.entity.js';
import { TeamModule } from '../team/team.module.js';
import { TaskController } from './task.controller.js';
import { Task } from './task.entity.js';
import { TaskService } from './task.service.js';
import { AuthorizationModule } from '../auth/authorization.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    TypeOrmModule.forFeature([Task, Project, Team, Badge]),
    TeamModule,
  ],
  controllers: [TaskController],
  providers: [TaskService],
  exports: [TaskService, TypeOrmModule],
})
export class TaskModule {}
