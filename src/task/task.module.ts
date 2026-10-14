import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Badge } from '../badge/badge.entity.js';
import { Project } from '../project/project.entity.js';
import { Team } from '../team/team.entity.js';
import { TeamModule } from '../team/team.module.js';
import { MilestoneModule } from '../milestone/milestone.module.js';
import { NotificationModule } from '../notification/notification.module.js';
import { TaskController } from './task.controller.js';
import { Task } from './task.entity.js';
import { Subtask } from '../subtask/subtask.entity.js';
import { TimeEntry } from '../time-entry/time-entry.entity.js';
import { TaskService } from './task.service.js';
import { AuthorizationModule } from '../auth/authorization.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    // Subtask and TimeEntry are here for the cascading delete and the subtask
    // rollup, not for reads.
    TypeOrmModule.forFeature([Task, Project, Team, Badge, Subtask, TimeEntry]),
    TeamModule,
    // Assignment validation (active team member) and milestone resolution come
    // from these two services; notifications are the persistence of the events
    // the task flow raises.
    MilestoneModule,
    NotificationModule,
  ],
  controllers: [TaskController],
  providers: [TaskService],
  exports: [TaskService, TypeOrmModule],
})
export class TaskModule {}
