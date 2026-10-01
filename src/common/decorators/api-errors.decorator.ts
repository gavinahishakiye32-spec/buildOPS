import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { ErrorResponseDto } from '../dto/error-response.dto.js';

const DEFAULT_DESCRIPTIONS: Record<number, string> = {
  400: 'Validation or business rule failed',
  401: 'Missing or invalid access token',
  403: 'Permission denied',
  404: 'Resource not found in this organization',
  409: 'Conflicting state (duplicate or already exists)',
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
