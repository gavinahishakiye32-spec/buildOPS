import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlanModule } from '../plan/plan.module.js';
import { PlanLimitModule } from '../plan-limit/plan-limit.module.js';
import { SubscriptionController } from './subscription.controller.js';
import { Subscription } from './subscription.entity.js';
import { SubscriptionService } from './subscription.service.js';
import { AuthorizationModule } from '../auth/authorization.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';

@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    TypeOrmModule.forFeature([Subscription]),
    PlanModule,
    PlanLimitModule,
    BillingModule,
  ],
  controllers: [SubscriptionController],
  providers: [SubscriptionService],
  exports: [SubscriptionService],
})
export class SubscriptionModule {}
