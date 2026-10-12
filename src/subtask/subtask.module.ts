import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationModule } from '../notification/notification.module.js';
import { Project } from '../project/project.entity.js';
import { RoleModule } from '../role/role.module.js';
import { Task } from '../task/task.entity.js';
import { TaskModule } from '../task/task.module.js';
import { SubtaskController } from './subtask.controller.js';
import { SubtaskFeedController } from './subtask-feed.controller.js';
import { Subtask } from './subtask.entity.js';
import { TimeEntry } from '../time-entry/time-entry.entity.js';
import { User } from '../user/user.entity.js';
import { SubtaskService } from './subtask.service.js';
import { AuthorizationModule } from '../auth/authorization.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    // TimeEntry is here for the cascading delete, not for reads.
    TypeOrmModule.forFeature([Subtask, Task, Project, TimeEntry, User]),
    // The routes are nested under a task, so the parent task has to be resolved
    // (and its existence proven) before a subtask is read or written.
    TaskModule,
    // For the membership check behind assignment, and the assignable-member
    // list the picker reads.
    RoleModule,
    // For the assignment notification: assigning a subtask is what rings the
    // bell for whoever receives it.
    NotificationModule,
  ],
  controllers: [SubtaskController, SubtaskFeedController],
  providers: [SubtaskService],
  exports: [SubtaskService],
})
export class SubtaskModule {}
