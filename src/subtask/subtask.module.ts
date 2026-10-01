import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Project } from '../project/project.entity.js';
import { Task } from '../task/task.entity.js';
import { TaskModule } from '../task/task.module.js';
import { TeamModule } from '../team/team.module.js';
import { SubtaskController } from './subtask.controller.js';
import { Subtask } from './subtask.entity.js';
import { SubtaskService } from './subtask.service.js';
import { AuthorizationModule } from '../auth/authorization.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    TypeOrmModule.forFeature([Subtask, Task, Project]),
    // The routes are nested under a task, so the parent task has to be resolved
    // (and its existence proven) before a subtask is read or written.
    TaskModule,
    TeamModule,
  ],
  controllers: [SubtaskController],
  providers: [SubtaskService],
  exports: [SubtaskService],
})
export class SubtaskModule {}
