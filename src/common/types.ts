import type { Request } from 'express';
import type { PermissionName } from './permissions.js';

/** Safe user shape attached by the JWT strategy. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string | null;
  status: string | null;
  organizationId: string | null;
  isVerified: boolean;
  /**
   * The session this access token belongs to, from the token's `sid` claim.
   *
   * The strategy has already checked it is still alive; carrying it on the
   * request lets endpoints that act on the current session -- the sessions
   * list, and anything that revokes it -- know which one this is.
   */
  sessionId: string;
}

/**
 * Resolved authorization context (spec §5/§15):
 * `Authentication → Subscription context → Organization context → Role/Permissions`.
 */
export interface AuthContext {
  userId: string;
  organizationId: string | null;
  roleId: string | null;
  permissions: PermissionName[];
  /** Session behind the presented access token; see `AuthenticatedUser.sessionId`. */
  sessionId: string;
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
  authContext: AuthContext;
}

/** Header carrying the active organization for organization-scoped routes. */
export const ORGANIZATION_HEADER = 'x-organization-id';
