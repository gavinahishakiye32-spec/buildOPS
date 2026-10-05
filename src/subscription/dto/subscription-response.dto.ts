import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PlanResponseDto } from '../../plan/dto/plan-response.dto.js';
import {
  PLAN_LIMIT_RESOURCES,
  SUBSCRIPTION_STATUSES,
} from '../../common/enums.js';

export class SubscriptionResponseDto {
  @ApiProperty({ example: '4c1f5c66-2f9e-4f5c-8b2a-9c0d1e2f3a4b' })
  id: string;

  @ApiProperty({ example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d' })
  userId: string;

  @ApiPropertyOptional({
    example: 'b6f0e2a1-9f2a-4a6f-8f1e-2c9a5b7d1e33',
    description:
      'Plan in force. Null before the first payment settles and while a plan change is still being paid for, in which case the previous plan is also null and pendingPlan names the one being bought.',
  })
  planId: string | null;

  @ApiPropertyOptional({ type: PlanResponseDto, nullable: true })
  plan: PlanResponseDto | null;

  @ApiProperty({ enum: SUBSCRIPTION_STATUSES, example: 'active' })
  status: string;

  @ApiPropertyOptional({
    example: '2026-10-16T10:00:00.000Z',
    description:
      'When a trial stops granting capacity. Null unless the subscription was started as a trial.',
  })
  trialEndsAt: Date | null;

  @ApiProperty({
    example: false,
    description:
      'True once the trial has passed. A lapsed trial keeps its data and stops accepting organizations, members and projects until a plan is chosen.',
  })
  isTrialExpired: boolean;

  @ApiPropertyOptional({
    type: PlanResponseDto,
    nullable: true,
    description:
      'Plan currently being paid for, or null when no purchase is in flight.',
  })
  pendingPlan: PlanResponseDto | null;

  @ApiPropertyOptional({
    example: 'sub_1234abcd',
    nullable: true,
    description: 'Payment provider handle for the recurring agreement',
  })
  billingSubscriptionRef: string | null;

  @ApiProperty({ example: '2026-09-30T10:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-09-30T10:00:00.000Z' })
  updatedAt: Date;
}

/** The payment state a plan change is in. */
export class PurchaseStateDto {
  @ApiProperty({ enum: ['pending', 'settled'], example: 'pending' })
  status: string;

  @ApiPropertyOptional({
    example: 'https://checkout.example.com/session/cs_test_123',
    nullable: true,
    description:
      'Where to complete payment. Present only while the purchase is pending.',
  })
  checkoutUrl: string | null;
}

export class PlanUsageDto {
  @ApiProperty({
    enum: PLAN_LIMIT_RESOURCES,
    example: 'organizations',
    description: 'Limited resource',
  })
  resource: string;

  @ApiProperty({ example: 1, description: 'Capacity currently consumed' })
  used: number;

  @ApiProperty({ example: 3, description: 'Limit granted by the plan' })
  limit: number;

  @ApiProperty({ example: 2, description: 'Remaining capacity' })
  remaining: number;
}

/** A subscription paired with the capacity it has consumed so far. */
export class SubscriptionWithUsageDto {
  @ApiProperty({ type: SubscriptionResponseDto })
  subscription: SubscriptionResponseDto;

  @ApiProperty({
    type: [PlanUsageDto],
    description: 'Current usage against plan limits',
  })
  usage: PlanUsageDto[];

  @ApiPropertyOptional({
    type: PurchaseStateDto,
    description:
      'Payment state of the most recent plan change. Absent when the plan was not changed.',
  })
  purchase?: PurchaseStateDto;
}

export class SubscriptionCreatedResponseDto extends SubscriptionWithUsageDto {
  @ApiProperty({ example: 'Subscription active' })
  message: string;
}

/**
 * Answered with 202: the purchase was started but the money has not arrived, so
 * `subscription.planId` still holds the plan in force before the change.
 */
export class PurchasePendingResponseDto extends SubscriptionWithUsageDto {
  @ApiProperty({ example: 'Complete the payment to activate this plan' })
  message: string;
}

export class SubscriptionMessageResponseDto {
  @ApiProperty({ example: 'Subscription cancelled' })
  message: string;
}
