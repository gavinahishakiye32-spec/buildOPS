import { describe, expect, it } from '@jest/globals';
import { ALL_PERMISSIONS, DEFAULT_ROLE_TEMPLATES, isPermissionName } from '../common/permissions.js';

describe('default role templates', () => {
  it('only references known permissions', () => {
    for (const template of DEFAULT_ROLE_TEMPLATES) {
      for (const permission of template.permissions) {
        expect(isPermissionName(permission)).toBe(true);
      }
    }
  });

  it('gives the owner every permission of the catalog', () => {
    const owner = DEFAULT_ROLE_TEMPLATES.find((template) => template.key === 'owner');
    expect(owner).toBeDefined();
    expect([...owner!.permissions].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it('never gives the viewer a write permission', () => {
    const viewer = DEFAULT_ROLE_TEMPLATES.find((template) => template.key === 'viewer');
    expect(viewer).toBeDefined();
    expect(
      viewer!.permissions.filter((permission) => !permission.endsWith('.view')),
    ).toEqual([]);
  });

  it('keeps the template keys unique', () => {
    const keys = DEFAULT_ROLE_TEMPLATES.map((template) => template.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
