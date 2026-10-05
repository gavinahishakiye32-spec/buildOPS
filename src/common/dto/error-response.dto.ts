import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The body of every non-2xx response (spec §17), as Nest's built-in exception
 * layer emits it. `message` is a single string for business errors and an array
 * of strings for validation failures, so clients must normalise it before
 * rendering.
 *
 * The `oneOf` on `message` is explicit: the plugin cannot express the TS union
 * and would otherwise emit `"type": "object"`, which breaks client codegen.
 *
 * `error` is **optional on purpose**: Nest only includes it when the exception
 * carries a message (`new UnauthorizedException('Invalid credentials')`). The
 * two most frequent errors omit it — a rejected JWT answers
 * `{ statusCode: 401, message: 'Unauthorized' }` and a rate-limited call answers
 * `{ statusCode: 429, message: 'ThrottlerException: Too Many Requests' }`.
 * Treating it as required would make every client crash on the 401 it sees most.
 *
 * There is no `timestamp` or `path` field: no global exception filter adds them,
 * so documenting them would promise keys the API never sends.
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

  @ApiPropertyOptional({
    enum: [
      'Bad Request',
      'Unauthorized',
      'Forbidden',
      'Not Found',
      'Conflict',
      'Too Many Requests',
    ],
    example: 'Bad Request',
    description:
      'Status name. Absent on the 401 of a rejected or expired JWT and on every 429, because those exceptions are thrown without a message.',
  })
  error?: string;
}
