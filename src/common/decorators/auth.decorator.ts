import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { AuthContext, AuthenticatedRequest } from '../types.js';

export const IS_PUBLIC_KEY = 'isPublic';
export const REQUIRED_PERMISSIONS_KEY = 'requiredPermissions';
export const SKIP_ORGANIZATION_KEY = 'skipOrganization';

/** Marks a route as reachable without a JWT (spec §17). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Requires a JWT but no organization context (tenant-level endpoints). */
export const SkipOrganization = () => SetMetadata(SKIP_ORGANIZATION_KEY, true);

/** Injects the resolved authorization context (org, role, permissions). */
export const Auth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.authContext;
  },
);
