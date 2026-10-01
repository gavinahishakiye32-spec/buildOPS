import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtension,
  ApiHeader,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard.js';
import { PermissionsGuard } from '../guards/permissions.guard.js';
import { ORGANIZATION_HEADER } from '../types.js';
import { ErrorResponseDto } from '../dto/error-response.dto.js';
import {
  REQUIRED_PERMISSIONS_KEY,
  SKIP_ORGANIZATION_KEY,
} from './auth.decorator.js';
import type { PermissionName } from '../permissions.js';

const UNAUTHORIZED_DESCRIPTION = 'Missing, invalid or expired access token';

/**
 * The standard protected route: JWT + organization context + permission check
 * (spec §5/§15). Applied per controller to keep the pipeline explicit.
 */
export const Protected = () =>
  applyDecorators(
    UseGuards(JwtAuthGuard, PermissionsGuard),
    ApiBearerAuth(),
    ApiExtension('x-auth', {
      required: true,
      scheme: 'bearer',
      context: 'organization',
    }),
    ApiUnauthorizedResponse({
      description: UNAUTHORIZED_DESCRIPTION,
      type: ErrorResponseDto,
    }),
  );

/**
 * A route that needs a JWT but no organization context and no permission check.
 * The two `/auth/profile` routes use it, because the profile belongs to the user
 * rather than to an organization.
 */
export const BearerProfile = () =>
  applyDecorators(
    SetMetadata(SKIP_ORGANIZATION_KEY, true),
    UseGuards(JwtAuthGuard),
    ApiBearerAuth(),
    ApiExtension('x-auth', {
      required: true,
      scheme: 'bearer',
      context: 'user',
    }),
    ApiExtension('x-organization-context', { required: false }),
    ApiUnauthorizedResponse({
      description: UNAUTHORIZED_DESCRIPTION,
      type: ErrorResponseDto,
    }),
  );

/** Documented organization-context header, added to every org-scoped route. */
export const OrganizationHeader = () =>
  applyDecorators(
    ApiHeader({
      name: ORGANIZATION_HEADER,
      required: false,
      description:
        'Active organization id. Optional on /organizations/:organizationId routes, required on every other organization-scoped route.',
      schema: { type: 'string', format: 'uuid' },
    }),
    ApiExtension('x-organization-context', {
      required: true,
      header: ORGANIZATION_HEADER,
      pathParameter: 'organizationId',
    }),
  );

/**
 * Declares the permissions required by the route. The same list is enforced by
 * `PermissionsGuard` and published to the OpenAPI document as `x-permissions`,
 * so the documentation can never drift from the check.
 */
export const RequirePermissions = (...permissions: PermissionName[]) =>
  applyDecorators(
    SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions),
    ApiExtension('x-permissions', permissions),
  );
