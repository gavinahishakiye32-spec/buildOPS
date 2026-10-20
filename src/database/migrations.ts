import type { MigrationInterface } from 'typeorm';
import { InitialSchema1700000000000 } from './migrations/1700000000000-initial-schema.js';
import { BillingAndTrialExpiry1700000000001 } from './migrations/1700000000001-billing-and-trial-expiry.js';
import { RefreshTokens1700000000002 } from './migrations/1700000000002-refresh-tokens.js';
import { SoftDeletes1700000000003 } from './migrations/1700000000003-soft-deletes.js';
import { Settings1700000000004 } from './migrations/1700000000004-settings.js';
import { AccountDeletion1700000000005 } from './migrations/1700000000005-account-deletion.js';
import { MemberInvitations1700000000006 } from './migrations/1700000000006-member-invitations.js';
import { InvitationRoleId1700000000007 } from './migrations/1700000000007-invitation-role-id.js';
import { OrganizationCurrency1700000000008 } from './migrations/1700000000008-organization-currency.js';
import { TaskAssignment1700000000009 } from './migrations/1700000000009-task-assignment.js';
import { DropTaskAssignee1700000000010 } from './migrations/1700000000010-drop-task-assignee.js';
import { Notifications1700000000011 } from './migrations/1700000000011-notifications.js';
import { Milestones1700000000012 } from './migrations/1700000000012-milestones.js';
import { RoleTemplateKeys1700000000013 } from './migrations/1700000000013-role-template-keys.js';
import { NotificationEmails1700000000014 } from './migrations/1700000000014-notification-emails.js';
import { Chat1700000000015 } from './migrations/1700000000015-chat.js';

/**
 * The ordered migration list. TypeORM records what has run in the `migrations`
 * table, but the array itself still has to be passed in, so a migration added
 * here is what makes it visible to both the CLI and the application's
 * `migrationsRun`.
 */
export const MIGRATIONS: (new () => MigrationInterface)[] = [
  InitialSchema1700000000000,
  BillingAndTrialExpiry1700000000001,
  RefreshTokens1700000000002,
  SoftDeletes1700000000003,
  Settings1700000000004,
  AccountDeletion1700000000005,
  MemberInvitations1700000000006,
  InvitationRoleId1700000000007,
  OrganizationCurrency1700000000008,
  TaskAssignment1700000000009,
  DropTaskAssignee1700000000010,
  Notifications1700000000011,
  Milestones1700000000012,
  RoleTemplateKeys1700000000013,
  NotificationEmails1700000000014,
  Chat1700000000015,
];
