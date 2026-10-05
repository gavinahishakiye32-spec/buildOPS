import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { NEW_SUBSCRIPTION_STATUSES } from '../../common/enums.js';

export class SelectPlanDto {
  @ApiProperty({
    example: 'b6f0e2a1-9f2a-4a6f-8f1e-2c9a5b7d1e33',
    description: 'Identifier of the selected plan (see GET /plans)',
  })
  @IsUUID()
  planId: string;

  @ApiPropertyOptional({
    enum: NEW_SUBSCRIPTION_STATUSES,
    default: 'active',
    description:
      'Subscription status. "trial" starts a trial subscription; "active" activates immediately. A client cannot subscribe straight into a cancelled or suspended state.',
  })
  @IsOptional()
  @IsIn(NEW_SUBSCRIPTION_STATUSES)
  status?: string;
}

export class ChangePlanDto {
  @ApiProperty({ example: 'b6f0e2a1-9f2a-4a6f-8f1e-2c9a5b7d1e33' })
  @IsUUID()
  planId: string;
}
