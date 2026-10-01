import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard.js';
import { PermissionsGuard } from '../guards/permissions.guard.js';
import { ORGANIZATION_HEADER } from '../types.js';
import { ErrorResponseDto } from '../dto/error-response.dto.js';
import { IS_PUBLIC_KEY, REQUIRED_PERMISSIONS_KEY } from './auth.decorator.js';
import type { PermissionName } from '../permissions.js';

/**
 * The standard protected route: JWT + organization context + permission check
 * (spec §5/§15). Applied per controller to keep the pipeline explicit.
 */
export const Protected = () =>
  applyDecorators(
    SetMetadata(IS_PUBLIC_KEY, false),
    UseGuards(JwtAuthGuard, PermissionsGuard),
    ApiBearerAuth(),
    ApiUnauthorizedResponse({
      description: 'Missing, invalid or expired access token',
      type: ErrorResponseDto,
    }),
  );

/** Documented organization-context header, added to every org-scoped route. */
export const OrganizationHeader = () =>
  ApiHeader({
    name: ORGANIZATION_HEADER,
    required: false,
    description:
      'Active organization id. Optional on /organizations/:organizationId routes, required on every other organization-scoped route.',
    schema: { type: 'string', format: 'uuid' },
  });

/** Declares the permissions required by the route. */
export const RequirePermissions = (...permissions: PermissionName[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);
