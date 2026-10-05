import {
  applyDecorators,
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';
import type { AuthContext, AuthenticatedRequest } from '../types.js';

export const REQUIRED_PERMISSIONS_KEY = 'requiredPermissions';
export const SKIP_ORGANIZATION_KEY = 'skipOrganization';

/**
 * Requires a JWT but no organization context: the subscription/tenant-level
 * endpoints. It also corrects `x-auth.context`, which `Protected()` publishes as
 * `organization` at the class level, so the published value matches the check
 * that actually runs. Without it, `/subscription` and `GET /organizations` would
 * advertise an organization context the server never reads.
 */
export const SkipOrganization = () =>
  applyDecorators(
    SetMetadata(SKIP_ORGANIZATION_KEY, true),
    ApiExtension('x-auth', {
      required: true,
      scheme: 'bearer',
      context: 'subscription',
    }),
    ApiExtension('x-organization-context', { required: false }),
  );

/** Injects the resolved authorization context (org, role, permissions). */
export const Auth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.authContext;
  },
);
