import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Project } from '../project/project.entity.js';
import { Task } from '../task/task.entity.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../auth/authorization.module.js';
import { NotificationModule } from '../notification/notification.module.js';
import { MilestoneController } from './milestone.controller.js';
import { Milestone } from './milestone.entity.js';
import { MilestoneService } from './milestone.service.js';

@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    NotificationModule,
    // Task is here for the detach on delete, not for reads.
    TypeOrmModule.forFeature([Milestone, Project, Task]),
  ],
  controllers: [MilestoneController],
  providers: [MilestoneService],
  exports: [MilestoneService],
})
export class MilestoneModule {}