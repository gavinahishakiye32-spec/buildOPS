import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { PERMISSIONS } from '../common/permissions.js';
import { Role } from './role.entity.js';
import { Permission } from './permission.entity.js';
import { RoleService } from './role.service.js';

const roleRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'role-1',
  organizationId: 'org-1',
  userId: null,
  name: 'Reviewer',
  key: null,
  description: null,
  permissions: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('RoleService guard rails', () => {
  let roleRepo: any;
  let permissionRepo: any;
  let userService: any;
  let planLimits: any;
  let service: RoleService;

  beforeEach(() => {
    roleRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      save: jest.fn(),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      create: jest.fn(),
    };

    permissionRepo = {
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      save: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
    };

    userService = { findById: jest.fn() };
    planLimits = {
      requireByOrganizationId: jest.fn(),
      locked: jest.fn(),
    };

    service = new RoleService(
      roleRepo as never,
      permissionRepo as never,
      userService as never,
      planLimits as never,
    );
  });

  describe('deleteRole', () => {
    it('refuses to delete a role a member holds', async () => {
      roleRepo.findOne.mockResolvedValue(
        roleRow({ userId: 'member-1', name: 'Owner', key: 'owner' }),
      );

      await expect(
        service.deleteRole('org-1', 'role-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(roleRepo.delete).not.toHaveBeenCalled();
    });

    it('deletes an unassigned role definition', async () => {
      roleRepo.findOne.mockResolvedValue(roleRow());

      await service.deleteRole('org-1', 'role-1');

      expect(roleRepo.delete).toHaveBeenCalledWith('role-1');
    });
  });

  describe('unassignRole', () => {
    it('refuses to unassign the role the actor currently holds', async () => {
      roleRepo.findOne.mockResolvedValue(
        roleRow({ userId: 'actor-1' }),
      );

      await expect(
        service.unassignRole('org-1', 'role-1', 'actor-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(roleRepo.save).not.toHaveBeenCalled();
    });

    it('unassigns a role held by somebody else', async () => {
      const held = roleRow({ userId: 'member-1' });
      roleRepo.findOne.mockResolvedValue(held);

      const result = await service.unassignRole('org-1', 'role-1', 'actor-1');

      expect(roleRepo.save).toHaveBeenCalled();
      expect(result.userId).toBeNull();
    });
  });

  describe('replacePermissions', () => {
    it('refuses removing role.update from the actor own role', async () => {
      roleRepo.findOne.mockResolvedValue(
        roleRow({ userId: 'actor-1', permissions: [] }),
      );

      await expect(
        service.replacePermissions(
          'org-1',
          'role-1',
          { permissions: ['dashboard.view'] },
          'actor-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Nothing is touched: the refused role keeps the permission set it had.
      expect(permissionRepo.delete).not.toHaveBeenCalled();
      expect(permissionRepo.save).not.toHaveBeenCalled();
    });

    it('allows the actor to edit their own role while keeping role.update', async () => {
      roleRepo.findOne.mockResolvedValue(roleRow({ userId: 'actor-1' }));
      permissionRepo.save.mockResolvedValue([]);

      const result = await service.replacePermissions(
        'org-1',
        'role-1',
        { permissions: [PERMISSIONS.ROLE_UPDATE, PERMISSIONS.DASHBOARD_VIEW] },
        'actor-1',
      );

      expect(permissionRepo.delete).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('leaves roles held by another member fully editable', async () => {
      roleRepo.findOne.mockResolvedValue(roleRow({ userId: 'member-1' }));

      const result = await service.replacePermissions(
        'org-1',
        'role-1',
        { permissions: ['dashboard.view'] },
        'actor-1',
      );

      expect(permissionRepo.delete).toHaveBeenCalled();
      expect(result).toBeDefined();
    });
  });

  describe('updateMemberRole', () => {
    it('refuses changing the actor own role', async () => {
      await expect(
        service.updateMemberRole('org-1', 'actor-1', 'target-1', 'actor-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(roleRepo.findOne).not.toHaveBeenCalled();
    });
  });

  describe('assignNewRole seeding', () => {
    it('gives a member added through a template the template key (viewer default)', async () => {
      const user = { id: 'member-1', name: 'Pat', email: 'p@example.com' };
      userService.findById.mockResolvedValue({
        ...user,
        isVerified: true,
        organizationId: null,
      });

      const userRepo = {
        findOne: jest.fn().mockResolvedValue(user),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      // `assertMemberSlotFree` finds no existing membership, then `findRole`
      // (which reloads the row after saving) finds the new one.
      roleRepo.findOne.mockResolvedValueOnce(null);
      roleRepo.findOne.mockResolvedValue(
        roleRow({ userId: 'member-1', name: 'Viewer', key: 'viewer' }),
      );
      roleRepo.create.mockImplementation((values: unknown) => values);
      roleRepo.save.mockImplementation(async (record: unknown) => record);
      permissionRepo.create.mockImplementation((values: unknown) => values);
      permissionRepo.save.mockResolvedValue([]);

      const limits = {
        manager: {
          getRepository: (entity: unknown) => {
            if (entity === Role) return roleRepo;
            if (entity === Permission) return permissionRepo;
            return userRepo;
          },
        },
        assertUserSeat: jest.fn().mockResolvedValue(undefined),
      };
      planLimits.requireByOrganizationId.mockResolvedValue({ id: 'sub-1' });
      planLimits.locked.mockImplementation(
        async (_id: string, run: (l: typeof limits) => Promise<Role>) =>
          run(limits),
      );

      const result = await service.addMember('org-1', { userId: 'member-1' });

      expect(roleRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org-1',
          name: 'Viewer',
          key: 'viewer',
          userId: 'member-1',
        }),
      );
      expect(result.key).toBe('viewer');
      expect(roleRepo.save).toHaveBeenCalled();
    });
  });
});