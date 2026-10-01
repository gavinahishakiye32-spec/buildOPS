import {
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import type { AuthContext, AuthenticatedRequest } from '../types.js';

/** Authorization context of a route that always has an active organization. */
export interface OrganizationAuthContext extends AuthContext {
  organizationId: string;
}

/**
 * Injects the authorization context and guarantees an organization is active.
 * Use on every organization-scoped route; use `@Auth()` for subscription-level routes.
 */
export const OrgAuth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): OrganizationAuthContext => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const authContext = request.authContext;

    if (!authContext?.organizationId) {
      throw new ForbiddenException(
        'Organization context is required for this operation',
      );
    }

    return authContext as OrganizationAuthContext;
  },
);
