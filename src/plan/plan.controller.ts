import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PlanService } from './plan.service.js';
import { PlanResponseDto } from './dto/plan-response.dto.js';

@ApiTags('plans')
@Controller('plans')
export class PlanController {
  constructor(private readonly planService: PlanService) {}

  @Get()
  @ApiOperation({
    summary: 'List plans',
    description:
      'Public catalogue of subscription plans and their capacity limits (max_users, max_projects, max_storage_gb, max_organizations, price).',
  })
  @ApiResponse({ status: 200, description: 'Available plans', type: [PlanResponseDto] })
  async findAll(): Promise<PlanResponseDto[]> {
    const plans = await this.planService.findAll();
    return plans.map((plan) => plan.toResponse());
  }
}
