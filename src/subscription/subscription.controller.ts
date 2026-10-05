import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Auth, SkipOrganization } from '../common/decorators/auth.decorator.js';
import { ApiErrors } from '../common/decorators/api-errors.decorator.js';
import { Protected } from '../common/decorators/protected.decorator.js';
import type { AuthContext } from '../common/types.js';
import { SubscriptionService } from './subscription.service.js';
import type { PurchaseResult } from '../billing/billing-provider.js';
import { ChangePlanDto, SelectPlanDto } from './dto/select-plan.dto.js';
import {
  PlanUsageDto,
  PurchasePendingResponseDto,
  SubscriptionCreatedResponseDto,
  SubscriptionMessageResponseDto,
  SubscriptionWithUsageDto,
} from './dto/subscription-response.dto.js';
import type { SubscriptionResponse } from './subscription.entity.js';

@ApiTags('subscription')
// `@Protected()` already contributes `ApiBearerAuth`; declaring it here too
// emitted the security requirement twice on every operation.
@Protected()
@SkipOrganization()
@Controller('subscription')
export class SubscriptionController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  /**
   * Shapes the answer from whether the money has arrived.
   *
   * The status code is the part of the contract a client actually branches on:
   * 200 means the plan is in force and the usage figures are final, 202 means a
   * purchase is outstanding and `planId` still holds the previous plan. Folding
   * both into one 200 with a nullable field would let a client treat an unpaid
   * Business plan as active.
   *
   * The code is set on the response rather than with `@HttpCode` because it
   * depends on what the provider did: a decorator would pin one value for both
   * branches, and the pending one would silently answer 200.
   */
  private respond(
    response: Response,
    subscription: SubscriptionResponse,
    usage: PlanUsageDto[],
    purchase: PurchaseResult | null,
    message?: string,
  ): SubscriptionWithUsageDto | PurchasePendingResponseDto {
    if (purchase && !purchase.confirmed) {
      response.status(HttpStatus.ACCEPTED);

      return {
        message: 'Complete the payment to activate this plan',
        subscription,
        usage,
        purchase: {
          status: 'pending',
          checkoutUrl: purchase.checkoutUrl,
        },
      };
    }

    response.status(HttpStatus.OK);

    return {
      ...(message ? { message } : {}),
      subscription,
      usage,
      ...(purchase
        ? { purchase: { status: 'settled', checkoutUrl: null } }
        : {}),
    };
  }

  @Post()
  @ApiOperation({
    summary: 'Subscribe to a plan',
    description:
      'Creates (or reactivates) the subscription for the authenticated user and starts payment for the selected plan. A trial is granted immediately and expires after TRIAL_DAYS. A paid plan is applied only once payment settles: the response is 200 when it has, and 202 with a checkoutUrl to visit when it has not. Limits are enforced from that point on: max_organizations, max_users, max_projects.',
  })
  @ApiResponse({
    status: 200,
    description: 'Payment settled; the plan is in force',
    type: SubscriptionCreatedResponseDto,
  })
  @ApiResponse({
    status: 202,
    description:
      'Payment started but not settled; complete the checkout before the plan applies',
    type: PurchasePendingResponseDto,
  })
  @ApiErrors(400, 404, 409)
  async subscribe(
    @Auth() auth: AuthContext,
    @Body() dto: SelectPlanDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SubscriptionWithUsageDto | PurchasePendingResponseDto> {
    const result = await this.subscriptionService.subscribe(auth.userId, dto);
    const { subscription, usage, purchase } = result;

    return this.respond(
      response,
      subscription.toResponse(),
      usage,
      purchase,
      'Subscription active',
    );
  }

  @Get()
  @ApiOperation({
    summary: 'Get current subscription',
    description:
      'Returns the subscription of the authenticated user with the attached plan and current usage against every plan limit.',
  })
  @ApiOkResponse({
    description: 'Current subscription and usage',
    type: SubscriptionWithUsageDto,
  })
  @ApiErrors(404)
  async findMine(@Auth() auth: AuthContext): Promise<SubscriptionWithUsageDto> {
    const subscription = await this.subscriptionService.requireForUser(
      auth.userId,
    );
    const usage = await this.subscriptionService.usageSummary(subscription);

    return { subscription: subscription.toResponse(), usage };
  }

  @Get('usage')
  @ApiOperation({
    summary: 'Get plan usage',
    description:
      'Capacity consumed versus granted for organizations, users and projects.',
  })
  @ApiOkResponse({
    description: 'Usage per limited resource',
    type: [PlanUsageDto],
  })
  @ApiErrors(404)
  async usage(@Auth() auth: AuthContext): Promise<PlanUsageDto[]> {
    const subscription = await this.subscriptionService.requireForUser(
      auth.userId,
    );
    return this.subscriptionService.usageSummary(subscription);
  }

  @Patch('plan')
  @ApiOperation({
    summary: 'Change plan',
    description:
      'Starts payment for another plan. The current plan stays in force until the payment settles, so a plan is never granted without money behind it. Downgrades are rejected up front, while the current usage exceeds the target plan limits. The response is 200 when payment settled and 202 with a checkoutUrl when the customer has to complete a checkout first.',
  })
  @ApiOkResponse({
    description: 'Payment settled; the new plan is in force',
    type: SubscriptionWithUsageDto,
  })
  @ApiResponse({
    status: 202,
    description:
      'Payment started but not settled; complete the checkout before the plan applies',
    type: PurchasePendingResponseDto,
  })
  @ApiErrors(400, 404)
  async changePlan(
    @Auth() auth: AuthContext,
    @Body() dto: ChangePlanDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SubscriptionWithUsageDto | PurchasePendingResponseDto> {
    const subscription = await this.subscriptionService.requireForUser(
      auth.userId,
    );
    const { subscription: updated, usage, purchase } =
      await this.subscriptionService.changePlan(subscription, dto.planId);

    return this.respond(response, updated.toResponse(), usage, purchase);
  }

  @Delete()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cancel subscription',
    description:
      'Cancels the subscription. Data is preserved but capacity-consuming operations are refused until the subscription is reactivated by subscribing again.',
  })
  @ApiOkResponse({
    description: 'Subscription cancelled',
    type: SubscriptionMessageResponseDto,
  })
  @ApiErrors(404)
  async cancel(
    @Auth() auth: AuthContext,
  ): Promise<SubscriptionMessageResponseDto> {
    const subscription = await this.subscriptionService.requireForUser(
      auth.userId,
    );
    await this.subscriptionService.cancel(subscription);

    return { message: 'Subscription cancelled' };
  }
}
