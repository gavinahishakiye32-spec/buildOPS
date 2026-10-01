import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PlanResponseDto {
  @ApiProperty({ example: 'b6f0e2a1-9f2a-4a6f-8f1e-2c9a5b7d1e33' })
  id: string;

  @ApiProperty({ example: 'Growth' })
  name: string;

  @ApiPropertyOptional({ example: 'Multiple workspaces for growing delivery teams.' })
  description: string | null;

  @ApiProperty({ example: 25, description: 'Maximum users permitted' })
  maxUsers: number;

  @ApiProperty({ example: 25, description: 'Maximum projects permitted' })
  maxProjects: number;

  @ApiProperty({ example: 50, description: 'Maximum storage in GB' })
  maxStorageGb: number;

  @ApiProperty({ example: 3, description: 'Maximum organizations permitted' })
  maxOrganizations: number;

  @ApiProperty({ example: '79.00', description: 'Subscription price (DECIMAL(10,2))' })
  price: string;
}
