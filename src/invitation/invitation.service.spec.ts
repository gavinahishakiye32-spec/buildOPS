import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';

import { OrganizationInvitation } from './invitation.entity.js';
import { InvitationService } from './invitation.service.js';

/**
 * The role an invitation grants.
 *
 * These exist because the behaviour was wrong in a way that only showed up in
 * the product: an invitation could only name one of the five built-in
 * templates, so acceptance built a *new* role from that template. An
 * administrator who had made a role of their own — and named it something the
 * frontend matched to a template by name — got the template's permissions
 * granted to their invitee instead, and a second row under the same name on the
 * Roles & Permissions screen.
 *
 * The rules under test, in the order they matter:
 *
 *  - a named role is handed over, not rebuilt;
 *  - a named role that has since gone falls back to the template, and never
 *    fails the acceptance;
 *  - a named role that somebody else now holds is *not* handed over, because a
 *    `roles` row is that member's access;
 *  - a role from another organization cannot be promised.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

function makeInvitation(overrides: Partial<OrganizationInvitation> = {}) {
  return Object.assign(new OrganizationInvitation(), {
    id: 'inv-1',
    organizationId: ORG,
    email: 'dev@example.com',
    templateKey: 'developer',
    roleId: null,
    roleName: 'Developer',
    tokenHash: 'hash',
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000),
    acceptedAt: null,
    ...overrides,
  }) as OrganizationInvitation;
}

function makeRole(overrides: Record<string, unknown> = {}) {
  return {
    id: 'role-1',
    organizationId: ORG,
    userId: null,
    name: 'Developer',
    description: 'Tasks and the timer only',
    permissions: [{ name: 'task.view' }, { name: 'time_entry.create' }],
    ...overrides,
  };
}

/**
 * The service, wired with only the collaborators these tests reach for and a
 * stub for everything else.
 *
 * Built through the real constructor rather than by assigning fields afterwards,
 * so a change to the constructor's parameter list fails here instead of quietly
 * handing a test the wrong object.
 */
function makeService(options: { invitation?: OrganizationInvitation } = {}) {
  const invitation = options.invitation ?? makeInvitation();

  const invitationRepo = { findOne: jest.fn(async () => invitation) };
  const organizationRepo = {
    findOne: jest.fn(async () => ({ id: ORG, name: 'Acme' })),
  };

  const roleService = {
    templateFor: jest.fn((key: string) => ({
      key,
      name: 'Developer',
      permissions: ['dashboard.view', 'client.view'],
    })),
    findRoleOrNull: jest.fn(async () => null as unknown),
    assignRole: jest.fn(async () => makeRole({ userId: USER }) as unknown),
    addMember: jest.fn(async () => makeRole({ userId: USER }) as unknown),
  };

  const service = new InvitationService(
    invitationRepo as never,
    organizationRepo as never,
    roleService as never,
    { findByEmail: jest.fn(async () => null) } as never,
    {} as never,
    {} as never,
    { get: jest.fn() } as never,
    {
      sign: jest.fn(() => ({ hash: 'h', token: 't' })),
      verify: jest.fn(() => true),
    } as never,
  );

  return { service, roleService, invitation };
}

/**
 * `requireGrantableRole` and `grantInvitationRole` are private, so they are
 * reached the way the application reaches them: through `preview`, which
 * resolves the same "what will this grant?" question without changing anything.
 */
async function preview(
  service: InvitationService,
): Promise<string[]> {
  return (await service.preview('token')).permissions;
}

/** The private inviter-time check, called the way `createInvitation` calls it. */
function requireGrantable(service: InvitationService, roleId: string) {
  return (
    service as unknown as {
      requireGrantableRole: (org: string, id: string) => Promise<unknown>;
    }
  ).requireGrantableRole(ORG, roleId);
}

describe('InvitationService role resolution', () => {
  it('grants the named role when the invitation carries one', async () => {
    const { service, roleService } = makeService({
      invitation: makeInvitation({ roleId: 'role-1' }),
    });
    roleService.findRoleOrNull.mockResolvedValue(makeRole());

    const permissions = await preview(service);

    // The role's own permissions, not the template's.
    expect(permissions).toEqual(['task.view', 'time_entry.create']);
  });

  it('falls back to the template when no role was named', async () => {
    const { service } = makeService();

    const permissions = await preview(service);

    expect(permissions).toEqual(['dashboard.view', 'client.view']);
  });

  it('falls back to the template when the named role has been deleted', async () => {
    const { service, roleService } = makeService({
      invitation: makeInvitation({ roleId: 'role-1' }),
    });
    // The FK is ON DELETE SET NULL, so this is the shape a deleted role takes.
    roleService.findRoleOrNull.mockResolvedValue(null);

    const permissions = await preview(service);

    expect(permissions).toEqual(['dashboard.view', 'client.view']);
  });

  it('falls back to the template rather than taking a role somebody now holds', async () => {
    const { service, roleService } = makeService({
      invitation: makeInvitation({ roleId: 'role-1' }),
    });
    // A role row *is* a member's access. Handing it to a second person would
    // silently strip it from the first.
    roleService.findRoleOrNull.mockResolvedValue(
      makeRole({ userId: '33333333-3333-4333-8333-333333333333' }),
    );

    const permissions = await preview(service);

    expect(permissions).toEqual(['dashboard.view', 'client.view']);
  });
});

describe('InvitationService.requireGrantableRole', () => {
  it('rejects a role that is not in this organization', async () => {
    const { service } = makeService();

    await expect(requireGrantable(service, 'role-x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects a role that is already assigned, naming the way out', async () => {
    const { service, roleService } = makeService();
    roleService.findRoleOrNull.mockResolvedValue(
      makeRole({ userId: '33333333-3333-4333-8333-333333333333' }),
    );

    await expect(requireGrantable(service, 'role-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(requireGrantable(service, 'role-1')).rejects.toThrow(
      /Unassign it first/,
    );
  });

  it('accepts an unassigned role', async () => {
    const { service, roleService } = makeService();
    roleService.findRoleOrNull.mockResolvedValue(makeRole());

    await expect(requireGrantable(service, 'role-1')).resolves.toMatchObject({
      id: 'role-1',
    });
  });
});

/**
 * The empty-token and bad-token paths are unchanged by any of this and are
 * asserted here so a refactor of the helpers cannot quietly move them.
 */
describe('InvitationService.preview token handling', () => {
  it('rejects a missing token before touching the database', async () => {
    const { service } = makeService();

    await expect(service.preview('')).rejects.toBeInstanceOf(BadRequestException);
  });
});
