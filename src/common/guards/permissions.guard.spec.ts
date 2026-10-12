import { describe, expect, it } from '@jest/globals';

import { PermissionsGuard } from './permissions.guard.js';
import type { AuthContext, AuthenticatedRequest } from '../types.js';
import { ALL_PERMISSIONS } from '../permissions.js';

/**
 * `GET /organizations/:organizationId/me` exists because a client cannot work
 * out what to render without asking.
 *
 * The obvious route for that question is the member list, and it is the wrong
 * one: reading it needs `member.view`, which a `developer` or `tester` does not
 * hold. So a member without it had no way to learn its own permissions at all,
 * and the interface fell back to a snapshot cached when the invitation was
 * accepted — which kept offering links for permissions an administrator had
 * since revoked.
 *
 * What matters is therefore not that the guard resolves a membership — every
 * protected route relies on that — but that it resolves the *current* one and
 * publishes it, without a permission of its own getting in the way.
 */
describe('PermissionsGuard membership context', () => {
  const userId = '22222222-2222-4222-8222-222222222222';
  const organizationId = '11111111-1111-4111-8111-111111111111';
  const roleId = '33333333-3333-4333-8333-333333333333';

  /** A request shaped the way the guard expects to find one. */
  function makeRequest(): AuthenticatedRequest {
    return {
      user: { id: userId, sessionId: 'session-1' },
      params: { organizationId },
      headers: {},
    } as unknown as AuthenticatedRequest;
  }

  function makeGuard(resolve: (org: string, user: string) => Promise<unknown>) {
    const guard = new PermissionsGuard(
      { getAllAndOverride: () => undefined } as never,
      { resolve } as never,
    );
    return guard;
  }

  /** Minimal ExecutionContext that hands the guard its request and handler. */
  function makeContext(request: AuthenticatedRequest) {
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
    } as never;
  }

  it('publishes the live role name and permissions on the request', async () => {
    const request = makeRequest();
    const guard = makeGuard(async () => ({
      roleId,
      roleName: 'Developer',
      permissions: ['task.view', 'time_entry.create'],
    }));

    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

    const context: AuthContext = request.authContext;
    expect(context.organizationId).toBe(organizationId);
    expect(context.roleId).toBe(roleId);
    expect(context.roleName).toBe('Developer');
    expect(context.permissions).toEqual(['task.view', 'time_entry.create']);
  });

  it('carries no permissions a route can mistake for granted', async () => {
    // The case this exists for: a role that grants nothing still has to be
    // able to read its own membership, and must be handed an empty list rather
    // than an absent one the caller could mistake for "unknown".
    const request = makeRequest();
    const guard = makeGuard(async () => ({
      roleId,
      roleName: 'Restricted',
      permissions: [],
    }));

    await guard.canActivate(makeContext(request));

    expect(request.authContext.permissions).toEqual([]);
  });

  it('reflects a permission revoked after the role was created', async () => {
    // The guard reads the role on every request rather than caching it, so a
    // revocation takes effect on the next call. This is the property the
    // cached fallback could not provide.
    const request = makeRequest();
    let granted = ['client.view', 'task.view'];
    const guard = makeGuard(async () => ({
      roleId,
      roleName: 'Developer',
      permissions: granted,
    }));

    await guard.canActivate(makeContext(request));
    expect(request.authContext.permissions).toContain('client.view');

    granted = ['task.view'];
    const second = makeRequest();
    await guard.canActivate(makeContext(second));
    expect(second.authContext.permissions).not.toContain('client.view');
  });

  it('reports the full catalogue for the owner', async () => {
    const request = makeRequest();
    const guard = makeGuard(async () => ({
      roleId,
      roleName: 'Owner',
      permissions: [...ALL_PERMISSIONS],
    }));

    await guard.canActivate(makeContext(request));

    expect(request.authContext.permissions).toHaveLength(ALL_PERMISSIONS.length);
  });
});
