import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { ErrorResponseDto } from '../dto/error-response.dto.js';

const DEFAULT_DESCRIPTIONS: Record<number, string> = {
  400: 'Validation failed (one message per invalid field) or a business rule was violated',
  401: 'Missing, invalid or expired access token',
  403: 'Permission denied, or you are not a member of the active organization',
  404: 'Resource not found, or it belongs to another organization',
  409: 'Conflicting state: the resource already exists',
  429: 'Rate limited',
};

/**
 * Documents the error responses an endpoint can actually return, so the
 * OpenAPI contract matches runtime behaviour (enforced by the e2e contract test).
 */
export const ApiErrors = (...statuses: number[]) =>
  applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: DEFAULT_DESCRIPTIONS[status] ?? 'Error',
        type: ErrorResponseDto,
      }),
    ),
  );

/**
 * `ThrottlerGuard` is registered globally in `AppModule`, so **every** route can
 * answer 429 and the OpenAPI document has to say so. Applied at the class level
 * of each published controller so a new controller cannot forget it, and asserted
 * per operation by `test/openapi.e2e-spec.ts`.
 */
export const ApiRateLimited = () =>
  applyDecorators(
    ApiResponse({
      status: 429,
      description:
        'Rate limited. The `default` bucket allows 300 requests per 60 s per client IP; the auth routes use the stricter `auth` bucket.',
      type: ErrorResponseDto,
    }),
  );
