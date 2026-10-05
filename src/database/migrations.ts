import type { MigrationInterface } from 'typeorm';
import { InitialSchema1700000000000 } from './migrations/1700000000000-initial-schema.js';

/**
 * The ordered migration list. TypeORM records what has run in the `migrations`
 * table, but the array itself still has to be passed in, so a migration added
 * here is what makes it visible to both the CLI and the application's
 * `migrationsRun`.
 */
export const MIGRATIONS: (new () => MigrationInterface)[] = [
  InitialSchema1700000000000,
];