import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PlanResponseDto } from '../../plan/dto/plan-response.dto.js';

export class TenantResponseDto {
  @ApiProperty({ example: '4c1f5c66-2f9e-4f5c-8b2a-9c0d1e2f3a4b' })
  id: string;

  @ApiProperty({ example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d' })
  userId: string;

  @ApiPropertyOptional({
    example: 'b6f0e2a1-9f2a-4a6f-8f1e-2c9a5b7d1e33',
    description: 'Selected plan; null only before the first subscription',
  })
  planId: string | null;

  @ApiPropertyOptional({ type: PlanResponseDto, nullable: true })
  plan: PlanResponseDto | null;

  @ApiProperty({
    enum: ['trial', 'active', 'cancelled', 'suspended'],
    example: 'active',
  })
  status: string;

  @ApiProperty({ example: '2026-09-30T10:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-09-30T10:00:00.000Z' })
  updatedAt: Date;
}

export class PlanUsageDto {
  @ApiProperty({
    enum: ['organizations', 'users', 'projects'],
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

export class SubscriptionResponseDto {
  @ApiProperty({ type: TenantResponseDto })
  subscription: TenantResponseDto;

  @ApiProperty({
    type: [PlanUsageDto],
    description: 'Current usage against plan limits',
  })
  usage: PlanUsageDto[];
}

export class SubscriptionCreatedResponseDto extends SubscriptionResponseDto {
  @ApiProperty({ example: 'Subscription active' })
  message: string;
}

export class SubscriptionMessageResponseDto {
  @ApiProperty({ example: 'Subscription cancelled' })
  message: string;
}