import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Badge } from '../badge/badge.entity.js';
import { Project } from '../project/project.entity.js';
import { Subtask } from '../subtask/subtask.entity.js';
import { SubtaskService } from '../subtask/subtask.service.js';
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
    TypeOrmModule.forFeature([Task, Subtask, Project, Team, Badge]),
    TeamModule,
  ],
  controllers: [TaskController],
  providers: [TaskService, SubtaskService],
  exports: [TaskService, SubtaskService, TypeOrmModule],
})
export class TaskModule {}