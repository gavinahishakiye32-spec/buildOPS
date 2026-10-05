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
  'time_entries',
  'time_complexity',
  'subtasks',
  'tasks',
  'badges',
  'projects',
  'clients',
  'team_members',
  'teams',
  'permissions',
  'roles',
  'organizations',
  'tenants',
  'users',
];

/** Empties every table the suites write to and resets their sequences. */
export async function resetDatabase(dataSource: DataSource): Promise<void> {
  await dataSource.query(
    `TRUNCATE TABLE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`,
  );
}
