import { ApiProperty } from '@nestjs/swagger';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ErrorResponseDto {
  @ApiProperty({
    example: 'Validation failed',
    description: 'Human readable error summary',
  })
  statusCode: number;

  @ApiProperty({
    example: 'Bad Request',
    description: 'HTTP status message',
  })
  message: string | string[];

  @ApiProperty({
    example: 'Bad Request Exception',
    description: 'Exception name',
  })
  error: string;

  @ApiPropertyOptional({
    example: '2026-09-30T22:00:00.000Z',
    description: 'Timestamp of the failed request',
  })
  timestamp?: string;

  @ApiPropertyOptional({ example: '/clients' })
  path?: string;
}
