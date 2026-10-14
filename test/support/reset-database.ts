import type { DataSource } from 'typeorm';

/**
 * Every table the e2e suites clear between runs.
 *
 * This list used to be copy-pasted into each suite. It was already duplicated
 * three times, and it was guaranteed to go stale: a new table is added to the
 * schema, its suite forgets it, and a test then reads a row left behind by the
 * suite before it. The symptom is a test that fails only when the file runs in a
 * different order, or passes for the wrong reason.
 *
 * Listing the tables rather than truncating the whole schema is deliberate.
 * `plans` holds the seeded plan catalogue the subscription and limit tests read,
 * and wiping it would take out the fixture those tests are built on.
 */
const TABLES = [
  // Before their owners: both cascade from `users` and `organizations`, but
  // listing them first keeps the intent obvious if the cascade ever changes.
  'organization_settings',
  'user_settings',
  'refresh_tokens',
  'notification_emails',
  'notifications',
  'time_entries',
  'time_complexity',
  'subtasks',
  'tasks',
  'milestones',
  'badges',
  'projects',
  'clients',
  'team_members',
  'teams',
  'organization_invitations',
  'permissions',
  'roles',
  'organizations',
  'tenants',
  'users',
];

/** Empties every table the suites write to and resets their sequences. */
export async function resetDatabase(dataSource: DataSource): Promise<void> {
  /**
   * A suite truncates every table, so it must never be pointed at the database
   * the application runs against. The e2e setup file moves the suites onto
   * `<DB_DATABASE>_test`, and this refuses anything else rather than trusting
   * that file to have run — a developer who runs a spec directly, or an
   * override of the config, should lose nothing.
   *
   * The escape hatch exists for the case where the test database genuinely has
   * another name. It is deliberately awkward to type, because reaching for it
   * should be a decision rather than a reflex.
   */
  const name = dataSource.options.database as string;

  if (!name.endsWith("_test") && process.env.ALLOW_TRUNCATE !== 'i-understand-this-truncates') {
    throw new Error(
      `Refusing to truncate "${name}": it does not end in "_test". The e2e ` +
        'suites wipe every table. Point DB_DATABASE at a test database, or set ' +
        'ALLOW_TRUNCATE=i-understand-this-truncates if this one really is a ' +
        'throwaway database.',
    );
  }

  await dataSource.query(
    `TRUNCATE TABLE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`,
  );
}
