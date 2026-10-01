import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Auth } from '../common/decorators/auth.decorator.js';
import { ApiErrors } from '../common/decorators/api-errors.decorator.js';
import { SkipOrganization } from '../common/decorators/auth.decorators.js';
import { Protected } from '../common/decorators/protected.decorator.js';
import type { AuthContext } from '../common/types.js';
import { TenantService } from './tenant.service.js';
import { ChangePlanDto, SelectPlanDto } from './dto/select-plan.dto.js';
import {
  PlanUsageDto,
  SubscriptionCreatedResponseDto,
  SubscriptionMessageResponseDto,
  SubscriptionResponseDto,
} from './dto/tenant-response.dto.js';

@ApiTags('subscription')
@ApiBearerAuth()
@Protected()
@SkipOrganization()
@Controller('subscription')
export class TenantController {
  constructor(private readonly tenantService: TenantService) {}

  @Post()
  @ApiOperation({
    summary: 'Subscribe to a plan',
    description:
      'Creates (or reactivates) the tenant subscription for the authenticated user and stores the selected plan. Limits are enforced from this point on: max_organizations, max_users, max_projects.',
  })
  @ApiResponse({
    status: 201,
    description: 'Subscription active',
    type: SubscriptionCreatedResponseDto,
  })
  @ApiErrors(400, 404, 409)
  async subscribe(
    @Auth() auth: AuthContext,
    @Body() dto: SelectPlanDto,
  ): Promise<SubscriptionCreatedResponseDto> {
    const tenant = await this.tenantService.subscribe(auth.userId, dto);
    const usage = await this.tenantService.usageSummary(tenant);

    return {
      message: 'Subscription active',
      subscription: tenant.toResponse(),
      usage,
    };
  }

  @Get()
  @ApiOperation({
    summary: 'Get current subscription',
    description:
      'Returns the tenant subscription of the authenticated user with the attached plan and current usage against every plan limit.',
  })
  @ApiOkResponse({
    description: 'Current subscription and usage',
    type: SubscriptionResponseDto,
  })
  @ApiErrors(404)
  async findMine(@Auth() auth: AuthContext): Promise<SubscriptionResponseDto> {
    const tenant = await this.tenantService.requireForUser(auth.userId);
    const usage = await this.tenantService.usageSummary(tenant);

    return { subscription: tenant.toResponse(), usage };
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
    const tenant = await this.tenantService.requireForUser(auth.userId);
    return this.tenantService.usageSummary(tenant);
  }

  @Patch('plan')
  @ApiOperation({
    summary: 'Change plan',
    description:
      'Switches the subscription to another plan. Downgrades are rejected while the current usage exceeds the target plan limits.',
  })
  @ApiOkResponse({
    description: 'Subscription with the new plan',
    type: SubscriptionResponseDto,
  })
  @ApiErrors(400, 404)
  async changePlan(
    @Auth() auth: AuthContext,
    @Body() dto: ChangePlanDto,
  ): Promise<SubscriptionResponseDto> {
    const tenant = await this.tenantService.requireForUser(auth.userId);
    const updated = await this.tenantService.changePlan(tenant, dto.planId);
    const usage = await this.tenantService.usageSummary(updated);

    return { subscription: updated.toResponse(), usage };
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
    const tenant = await this.tenantService.requireForUser(auth.userId);
    await this.tenantService.cancel(tenant);

    return { message: 'Subscription cancelled' };
  }
}
