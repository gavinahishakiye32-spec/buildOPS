export const PERMISSIONS = {
  ORGANIZATION_VIEW: 'organization.view',
  ORGANIZATION_CREATE: 'organization.create',
  ORGANIZATION_UPDATE: 'organization.update',
  ORGANIZATION_DELETE: 'organization.delete',
  MEMBER_VIEW: 'member.view',
  MEMBER_INVITE: 'member.invite',
  MEMBER_UPDATE: 'member.update',
  MEMBER_REMOVE: 'member.remove',
  ROLE_VIEW: 'role.view',
  ROLE_CREATE: 'role.create',
  ROLE_UPDATE: 'role.update',
  ROLE_DELETE: 'role.delete',
  ROLE_ASSIGN: 'role.assign',
  PERMISSION_VIEW: 'permission.view',
  TEAM_VIEW: 'team.view',
  TEAM_CREATE: 'team.create',
  TEAM_UPDATE: 'team.update',
  TEAM_DELETE: 'team.delete',
  TEAM_MEMBER_ADD: 'team.member.add',
  TEAM_MEMBER_REMOVE: 'team.member.remove',
  CLIENT_VIEW: 'client.view',
  CLIENT_CREATE: 'client.create',
  CLIENT_UPDATE: 'client.update',
  CLIENT_DELETE: 'client.delete',
  PROJECT_VIEW: 'project.view',
  PROJECT_CREATE: 'project.create',
  PROJECT_UPDATE: 'project.update',
  PROJECT_DELETE: 'project.delete',
  BADGE_VIEW: 'badge.view',
  BADGE_CREATE: 'badge.create',
  BADGE_UPDATE: 'badge.update',
  BADGE_DELETE: 'badge.delete',
  TASK_VIEW: 'task.view',
  TASK_CREATE: 'task.create',
  TASK_UPDATE: 'task.update',
  TASK_DELETE: 'task.delete',
  SUBTASK_VIEW: 'subtask.view',
  SUBTASK_CREATE: 'subtask.create',
  SUBTASK_UPDATE: 'subtask.update',
  SUBTASK_DELETE: 'subtask.delete',
  SUBTASK_ASSIGN: 'subtask.assign',
  TIME_ENTRY_VIEW: 'time_entry.view',
  TIME_ENTRY_VIEW_ALL: 'time_entry.view_all',
  TIME_ENTRY_CREATE: 'time_entry.create',
  TIME_ENTRY_UPDATE: 'time_entry.update',
  TIME_ENTRY_DELETE: 'time_entry.delete',
  TIME_ENTRY_START_TIMER: 'time_entry.start_timer',
  TIME_ENTRY_STOP_TIMER: 'time_entry.stop_timer',
  TIME_COMPLEXITY_VIEW: 'time_complexity.view',
  TIME_COMPLEXITY_CREATE: 'time_complexity.create',
  TIME_COMPLEXITY_UPDATE: 'time_complexity.update',
  TIME_COMPLEXITY_DELETE: 'time_complexity.delete',
  DASHBOARD_VIEW: 'dashboard.view',
} as const;

export type PermissionName = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: PermissionName[] = Object.values(PERMISSIONS);

const viewOnly = (resource: string): PermissionName[] => [
  `${resource}.view` as PermissionName,
];

export interface RoleTemplate {
  key: string;
  name: string;
  description: string;
  permissions: PermissionName[];
}

export const DEFAULT_ROLE_TEMPLATES: RoleTemplate[] = [
  {
    key: 'owner',
    name: 'Owner',
    description:
      'Subscription creator. Full access to every resource in the organization.',
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'project_manager',
    name: 'Project Manager',
    description:
      'Runs delivery: manages clients, projects, teams, tasks, subtasks and estimation.',
    permissions: [
      ...viewOnly('organization'),
      ...viewOnly('member'),
      ...viewOnly('role'),
      ...viewOnly('permission'),
      ...viewOnly('team'),
      'team.update' as PermissionName,
      'team.member.add' as PermissionName,
      'team.member.remove' as PermissionName,
      'client.create' as PermissionName,
      'client.update' as PermissionName,
      'client.delete' as PermissionName,
      'project.create' as PermissionName,
      'project.update' as PermissionName,
      'project.delete' as PermissionName,
      'badge.create' as PermissionName,
      'badge.update' as PermissionName,
      'badge.delete' as PermissionName,
      'task.create' as PermissionName,
      'task.update' as PermissionName,
      'task.delete' as PermissionName,
      'subtask.create' as PermissionName,
      'subtask.update' as PermissionName,
      'subtask.delete' as PermissionName,
      'subtask.assign' as PermissionName,
      PERMISSIONS.TIME_ENTRY_VIEW,
      PERMISSIONS.TIME_ENTRY_VIEW_ALL,
      PERMISSIONS.TIME_ENTRY_UPDATE,
      PERMISSIONS.TIME_ENTRY_DELETE,
      PERMISSIONS.TIME_ENTRY_START_TIMER,
      PERMISSIONS.TIME_ENTRY_STOP_TIMER,
      PERMISSIONS.TIME_COMPLEXITY_CREATE,
      PERMISSIONS.TIME_COMPLEXITY_UPDATE,
      PERMISSIONS.TIME_COMPLEXITY_DELETE,
      PERMISSIONS.DASHBOARD_VIEW,
    ],
  },
  {
    key: 'developer',
    name: 'Developer',
    description:
      'Creates and updates development tasks, subtasks and their own time.',
    permissions: [
      ...viewOnly('team'),
      ...viewOnly('client'),
      ...viewOnly('project'),
      ...viewOnly('badge'),
      ...viewOnly('time_complexity'),
      PERMISSIONS.TASK_CREATE,
      PERMISSIONS.TASK_UPDATE,
      PERMISSIONS.SUBTASK_CREATE,
      PERMISSIONS.SUBTASK_UPDATE,
      PERMISSIONS.SUBTASK_ASSIGN,
      PERMISSIONS.TIME_ENTRY_VIEW,
      PERMISSIONS.TIME_ENTRY_CREATE,
      PERMISSIONS.TIME_ENTRY_START_TIMER,
      PERMISSIONS.TIME_ENTRY_STOP_TIMER,
      PERMISSIONS.DASHBOARD_VIEW,
    ],
  },
  {
    key: 'tester',
    name: 'Tester',
    description: 'Reviews work, manages test subtasks and logs their own time.',
    permissions: [
      ...viewOnly('team'),
      ...viewOnly('project'),
      ...viewOnly('badge'),
      ...viewOnly('time_complexity'),
      PERMISSIONS.TASK_UPDATE,
      PERMISSIONS.SUBTASK_CREATE,
      PERMISSIONS.SUBTASK_UPDATE,
      PERMISSIONS.TIME_ENTRY_VIEW,
      PERMISSIONS.TIME_ENTRY_CREATE,
      PERMISSIONS.TIME_ENTRY_START_TIMER,
      PERMISSIONS.TIME_ENTRY_STOP_TIMER,
      PERMISSIONS.DASHBOARD_VIEW,
    ],
  },
  {
    key: 'viewer',
    name: 'Viewer',
    description: 'Read-only access to every resource of the organization.',
    permissions: [
      ...viewOnly('organization'),
      ...viewOnly('member'),
      ...viewOnly('role'),
      ...viewOnly('permission'),
      ...viewOnly('team'),
      ...viewOnly('client'),
      ...viewOnly('project'),
      ...viewOnly('badge'),
      ...viewOnly('task'),
      ...viewOnly('subtask'),
      ...viewOnly('time_entry'),
      ...viewOnly('time_complexity'),
      PERMISSIONS.DASHBOARD_VIEW,
    ],
  },
];

export function isPermissionName(value: string): value is PermissionName {
  return (ALL_PERMISSIONS as string[]).includes(value);
}

/** Keys of {@link DEFAULT_ROLE_TEMPLATES}, for the Swagger enum of `templateKey`. */
export const ROLE_TEMPLATE_KEYS: string[] = DEFAULT_ROLE_TEMPLATES.map(
  (template) => template.key,
);
