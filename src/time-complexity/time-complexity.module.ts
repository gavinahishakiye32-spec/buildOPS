import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Project } from '../project/project.entity.js';
import { Subtask } from '../subtask/subtask.entity.js';
import { Task } from '../task/task.entity.js';
import { TimeEntry } from '../time-entry/time-entry.entity.js';
import { TimeComplexityController } from './time-complexity.controller.js';
import { TimeComplexity } from './time-complexity.entity.js';
import { TimeComplexityService } from './time-complexity.service.js';
import { AuthorizationModule } from '../auth/authorization.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    TypeOrmModule.forFeature([
      TimeComplexity,
      Task,
      Subtask,
      TimeEntry,
      Project,
    ]),
  ],
  controllers: [TimeComplexityController],
  providers: [TimeComplexityService],
  exports: [TimeComplexityService],
})
export class TimeComplexityModule {}
