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

export const SUBSCRIPTION_STATUSES = [
  'trial',
  'pending_payment',
  'active',
  'cancelled',
  'suspended',
] as const;

/**
 * Statuses a client may ask for when subscribing. `cancelled` and `suspended`
 * are reachable only by transitions, so a client cannot subscribe straight into
 * an unusable state. `pending_payment` is deliberately absent: a client cannot
 * put itself into a state where a purchase is outstanding.
 */
export const NEW_SUBSCRIPTION_STATUSES = ['trial', 'active'] as const;

/**
 * Statuses whose subscription may consume plan capacity.
 *
 * `pending_payment` is excluded: it has no plan in force yet, so allowing it
 * would mean consuming capacity against whatever plan was attached before. These
 * two sets used to be the same list, which made `pending_payment` silently
 * usable the moment it was introduced.
 */
export const USABLE_SUBSCRIPTION_STATUSES = ['trial', 'active'] as const;

/** A subscription in one of these states may consume plan capacity. */
export function isUsableSubscriptionStatus(value: string): boolean {
  return (USABLE_SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}

/**
 * The subset of a subscription these predicates read. Declared structurally so
 * this module stays free of entity imports: `enums.ts` is imported by entities
 * and validators alike, and a type import of `Subscription` here would close a
 * cycle through the billing provider.
 */
export interface SubscriptionLifecyclish {
  status: string;
  trialEndsAt: Date | null;
}

/**
 * Whether a trial has run out. A `null` `trialEndsAt` means the subscription was
 * never a trial, so it cannot have expired.
 */
export function isTrialExpired(
  subscription: SubscriptionLifecyclish,
  now: Date = new Date(),
): boolean {
  return (
    subscription.status === 'trial' &&
    subscription.trialEndsAt !== null &&
    subscription.trialEndsAt.getTime() <= now.getTime()
  );
}

/**
 * Whether a subscription may consume plan capacity: the status has to allow it
 * *and*, for a trial, the trial has to still be running.
 *
 * This is the predicate the capacity checks use. It replaced a bare
 * `status === 'trial' || status === 'active'` test, under which a trial that
 * ended a month ago went on creating organizations for free.
 */
export function isUsableSubscription(
  subscription: SubscriptionLifecyclish,
  now: Date = new Date(),
): boolean {
  return (
    isUsableSubscriptionStatus(subscription.status) &&
    !isTrialExpired(subscription, now)
  );
}

/**
 * Why a subscription may not consume capacity, or null when it may.
 *
 * The wording lives here because two independent call sites refuse operations --
 * `PlanLimitService` when a limit would be exceeded and `SubscriptionService`
 * when a plan is being changed -- and they used to phrase the same refusal
 * differently. A customer who hit a limit and then tried to change plan was told
 * two unrelated things about why they were stuck.
 */
export function subscriptionRefusalReason(
  subscription: SubscriptionLifecyclish,
  now: Date = new Date(),
): string | null {
  if (isTrialExpired(subscription, now)) {
    return `The trial ended on ${subscription.trialEndsAt?.toISOString()}. Choose a plan to continue using the workspace.`;
  }

  if (!isUsableSubscriptionStatus(subscription.status)) {
    return `Subscription is ${subscription.status}. Reactivate it before using the workspace.`;
  }

  return null;
}

/** Resources a plan caps; the keys of the `max_*` columns on `Plan`. */
export const PLAN_LIMIT_RESOURCES = [
  'organizations',
  'users',
  'projects',
] as const;

export type PlanLimitResource = (typeof PLAN_LIMIT_RESOURCES)[number];

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
