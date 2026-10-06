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

/**
 * Whether an organization membership is live.
 *
 * `deactivated` is a suspension, not a deletion: the member keeps their role,
 * their permissions and their seat, and `activate` puts them back. What they
 * lose is access, because `RoleService.resolve` -- the query every
 * organization-scoped request is authorized through -- only resolves an
 * `active` membership.
 *
 * Removal is a different operation (`DELETE /members/:userId`), which is what
 * frees a plan seat.
 */
export const MEMBER_STATUSES = ['active', 'deactivated'] as const;

/**
 * The states of an invitation.
 *
 * `expired` is never stored. The row keeps `status = 'pending'` with an
 * `expires_at` in the past, and responses report `expired` for it, so the
 * read-only sweep a background job would otherwise need never has to run and a
 * lapsed invitation cannot be mistaken for one that is still waiting.
 */
export const INVITATION_STATUSES = [
  'pending',
  'accepted',
  'revoked',
  'expired',
] as const;

/** Stored invitation statuses; the subset a row can actually hold. */
export const STORED_INVITATION_STATUSES = [
  'pending',
  'accepted',
  'revoked',
] as const;

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

export const SETTINGS_THEMES = ['system', 'light', 'dark'] as const;

export const SETTINGS_LOCALES = ['en', 'fr', 'es', 'de', 'pt'] as const;

export const SETTINGS_DATE_FORMATS = [
  'YYYY-MM-DD',
  'DD/MM/YYYY',
  'MM/DD/YYYY',
] as const;

export const SETTINGS_TIME_FORMATS = ['24h', '12h'] as const;

export const SETTINGS_WEEK_STARTS = ['monday', 'sunday'] as const;

/**
 * Whether the reader wants to be interrupted.
 *
 * `in_app_only` and `off` exist because "email me about everything" is not
 * something every member of an organization wants, and a member who cannot
 * narrow it has no way to opt out at all. `off` is therefore a real value rather
 * than an absence: it has to survive a round trip through the database without
 * being mistaken for "never configured, so notify me".
 */
export const SETTINGS_DIGEST_FREQUENCIES = [
  'realtime',
  'daily',
  'weekly',
  'off',
] as const;

export type SettingsTheme = (typeof SETTINGS_THEMES)[number];
export type SettingsLocale = (typeof SETTINGS_LOCALES)[number];
export type SettingsDateFormat = (typeof SETTINGS_DATE_FORMATS)[number];
export type SettingsTimeFormat = (typeof SETTINGS_TIME_FORMATS)[number];
export type SettingsWeekStart = (typeof SETTINGS_WEEK_STARTS)[number];
export type SettingsDigestFrequency =
  (typeof SETTINGS_DIGEST_FREQUENCIES)[number];

/**
 * The settings a user sees before changing anything.
 *
 * These are the values written by the migration into every existing row *and*
 * the values a missing column falls back to, and the two have to be the same
 * list. Storing them at the database rather than filling them in the service
 * means a reader that bypasses the API still sees a usable value instead of a
 * null, and it keeps the "unset" state from being representable: every column
 * is NOT NULL, so there is no such thing as a partially configured settings row
 * to interpret at read time.
 */
export const DEFAULT_USER_SETTINGS = {
  theme: 'system' as SettingsTheme,
  locale: 'en' as SettingsLocale,
  timezone: 'UTC',
  dateFormat: 'YYYY-MM-DD' as SettingsDateFormat,
  timeFormat: '24h' as SettingsTimeFormat,
  digestFrequency: 'daily' as SettingsDigestFrequency,
} as const;

/**
 * The settings shared by everyone in an organization.
 *
 * `weekStart` and `timeFormat` default to the same values as a user's, so a
 * member who has never touched either gets the organization default rather than
 * a conflicting one. `workingDayStartMinutes`/`workingDayEndMinutes` are minutes
 * from midnight rather than a "09:00" string: the working window has to be
 * comparable as a number to compute an overlap, and a string column would push
 * that arithmetic into every caller.
 */
export const DEFAULT_ORGANIZATION_SETTINGS = {
  timezone: 'UTC',
  weekStart: 'monday' as SettingsWeekStart,
  timeFormat: '24h' as SettingsTimeFormat,
  workingDayStartMinutes: 9 * 60,
  workingDayEndMinutes: 17 * 60,
} as const;

/** IANA zone names, validated rather than trusted. */
export const TIMEZONE_PATTERN =
  /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;

/** 00:00 through 23:59 as `HH:MM`. */
export const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** How many minutes a single working-window bound may be. */
export const MAX_MINUTES_IN_DAY = 24 * 60 - 1;
