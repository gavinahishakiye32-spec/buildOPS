import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Client } from '../client/client.entity.js';
import { PlanLimitModule } from '../plan-limit/plan-limit.module.js';
import { ProjectController } from './project.controller.js';
import { Project } from './project.entity.js';
import { Task } from '../task/task.entity.js';
import { Subtask } from '../subtask/subtask.entity.js';
import { TimeEntry } from '../time-entry/time-entry.entity.js';
import { ProjectService } from './project.service.js';
import { AuthorizationModule } from '../auth/authorization.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    // The cascade flags tasks, subtasks and time entries as well, so the delete
    // needs those repositories in this module's own context.
    TypeOrmModule.forFeature([Project, Client, Task, Subtask, TimeEntry]),
    PlanLimitModule,
  ],
  controllers: [ProjectController],
  providers: [ProjectService],
  exports: [ProjectService, TypeOrmModule],
})
export class ProjectModule {}
