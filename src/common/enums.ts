/**
 * Closed value sets shared between validators (`@IsIn`) and the Swagger
 * `@ApiProperty({ enum })` of the same field, so a documented value can never
 * be one the validator rejects.
 *
 * `USER_STATUSES` covers the whole lifecycle; `SELF_EDITABLE_USER_STATUSES` is
 * the subset a user may set on their own profile.
 */
export const USER_STATUSES = ['active', 'inactive', 'suspended'] as const;

export const SELF_EDITABLE_USER_STATUSES = ['active', 'inactive'] as const;

export function isSelfEditableStatus(value: string): boolean {
  return (SELF_EDITABLE_USER_STATUSES as readonly string[]).includes(value);
}

export const TENANT_STATUSES = [
  'trial',
  'active',
  'cancelled',
  'suspended',
] as const;

/** Resources a plan caps; the keys of the `max_*` columns on `Plan`. */
export const PLAN_LIMIT_RESOURCES = [
  'organizations',
  'users',
  'projects',
] as const;

export const ORGANIZATION_STATUSES = [
  'active',
  'inactive',
  'archived',
] as const;

export const TEAM_STATUSES = ['active', 'inactive', 'archived'] as const;

export const TEAM_MEMBER_STATUSES = [
  'pending',
  'active',
  'inactive',
  'removed',
] as const;

export const TEAM_MEMBER_ROLES = ['lead', 'member', 'observer'] as const;

export const CLIENT_STATUSES = ['active', 'inactive', 'archived'] as const;

export const PROJECT_STATUSES = [
  'planned',
  'active',
  'on_hold',
  'completed',
  'cancelled',
] as const;

export const TASK_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;

export const TASK_STATUSES = [
  'todo',
  'in_progress',
  'in_review',
  'done',
  'cancelled',
] as const;

export const SUBTASK_STATUSES = [
  'todo',
  'in_progress',
  'done',
  'cancelled',
] as const;

export const TIME_COMPLEXITY_NAMES = [
  'low',
  'medium',
  'high',
  'critical',
] as const;

export const TIME_COMPLEXITY_STATUSES = ['active', 'archived'] as const;

/** How a logged duration compares to the subtask's estimation envelope. */
export const TIME_COMPLEXITY_VARIANCES = ['within', 'under', 'over'] as const;
