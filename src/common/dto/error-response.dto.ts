import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The body of every non-2xx response (spec §17). `message` is a single string
 * for business errors and an array of strings for validation failures, so
 * clients must normalise it before rendering.
 *
 * The `oneOf` on `message` is explicit: the plugin cannot express the TS union
 * and would otherwise emit `"type": "object"`, which breaks client codegen.
 */
export class ErrorResponseDto {
  @ApiProperty({ example: 400, description: 'HTTP status code' })
  statusCode: number;

  @ApiProperty({
    oneOf: [
      { type: 'string', example: 'Validation failed' },
      {
        type: 'array',
        items: { type: 'string' },
        example: ['name should not be empty', 'email must be an email'],
      },
    ],
    description:
      'Human readable summary: one string, or one string per invalid field',
  })
  message: string | string[];

  @ApiProperty({
    example: 'Bad Request Exception',
    description: 'Exception class name',
  })
  error: string;

  @ApiPropertyOptional({
    example: '2026-09-30T22:00:00.000Z',
    description: 'Timestamp of the failed request',
  })
  timestamp?: string;

  @ApiPropertyOptional({ example: '/clients', description: 'Request path' })
  path?: string;
}
