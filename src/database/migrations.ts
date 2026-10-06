import type { MigrationInterface } from 'typeorm';
import { InitialSchema1700000000000 } from './migrations/1700000000000-initial-schema.js';
import { BillingAndTrialExpiry1700000000001 } from './migrations/1700000000001-billing-and-trial-expiry.js';
import { RefreshTokens1700000000002 } from './migrations/1700000000002-refresh-tokens.js';
import { SoftDeletes1700000000003 } from './migrations/1700000000003-soft-deletes.js';
import { Settings1700000000004 } from './migrations/1700000000004-settings.js';
import { AccountDeletion1700000000005 } from './migrations/1700000000005-account-deletion.js';
import { MemberInvitations1700000000006 } from './migrations/1700000000006-member-invitations.js';

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
];
