export const USER_STATUSES = ['active', 'inactive', 'suspended'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const TENANT_STATUSES = [
  'trial',
  'active',
  'cancelled',
  'suspended',
] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const ORGANIZATION_STATUSES = [
  'active',
  'inactive',
  'archived',
] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

export const TEAM_STATUSES = ['active', 'inactive', 'archived'] as const;
export type TeamStatus = (typeof TEAM_STATUSES)[number];

export const TEAM_MEMBER_STATUSES = [
  'pending',
  'active',
  'inactive',
  'removed',
] as const;
export type TeamMemberStatus = (typeof TEAM_MEMBER_STATUSES)[number];

export const TEAM_MEMBER_ROLES = ['lead', 'member', 'observer'] as const;
export type TeamMemberRole = (typeof TEAM_MEMBER_ROLES)[number];

export const CLIENT_STATUSES = ['active', 'inactive', 'archived'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export const PROJECT_STATUSES = [
  'planned',
  'active',
  'on_hold',
  'completed',
  'cancelled',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const TASK_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_STATUSES = [
  'todo',
  'in_progress',
  'in_review',
  'done',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const SUBTASK_STATUSES = [
  'todo',
  'in_progress',
  'done',
  'cancelled',
] as const;
export type SubtaskStatus = (typeof SUBTASK_STATUSES)[number];

export const TIME_COMPLEXITY_NAMES = [
  'low',
  'medium',
  'high',
  'critical',
] as const;
export type TimeComplexityName = (typeof TIME_COMPLEXITY_NAMES)[number];

export const TIME_COMPLEXITY_STATUSES = ['active', 'archived'] as const;
export type TimeComplexityStatus = (typeof TIME_COMPLEXITY_STATUSES)[number];
