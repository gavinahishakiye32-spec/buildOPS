import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets a customer delete their own account.
 *
 * The account delete is the one delete in the API that is deliberately *not* a
 * hard `DELETE FROM users`, and the reason is the cascade under it. `tenants`
 * points at `users` with `ON DELETE CASCADE`, `organizations` points at
 * `tenants` the same way, and every operational table cascades from
 * `organizations`. So one row removed from `users` can erase an entire
 * workspace -- projects, tasks, subtasks and the hours logged against them --
 * because the person who happens to hold the subscription pressed a button on a
 * settings page. The rest of the API keeps hard deletes because they name the
 * record they are about (`DELETE /organizations/{id}`); a user cannot name the
 * workspaces behind their own row.
 *
 * `deleted_at` makes the account stop existing without removing it:
 *
 *  - Declared as a `@DeleteDateColumn` on the entity, so every existing read
 *    gains `deleted_at IS NULL` for free. `UserService.findById` and
 *    `findByEmail` stop resolving the row, which is what makes the very next
 *    request with the old access token a 401 in `JwtStrategy` rather than
 *    something that has to be checked in every guard.
 *  - The row survives so the foreign keys that reference it keep resolving:
 *    `subtasks.assigned_to` and `time_entries.user_id` are `ON DELETE SET NULL`,
 *    and a hard delete would quietly strip the name from hours that are a
 *    business record. A tombstone keeps the history attributable to the id it
 *    was always attributed to.
 *  - The identity itself is overwritten by the service rather than here -- see
 *    `AccountService.deleteAccount`. What the migration guarantees is only that
 *    there is a place to write the deletion timestamp at all.
 *
 * Deliberately absent, unlike `SoftDeletes1700000000003`:
 *
 *  - **No `deleted_by`.** The account deletes itself. There is no second party to
 *    record, and a column that can only ever hold the row's own id is a column
 *    that will be wrong the day somebody builds an admin route.
 *  - **No partial index on `email`.** `clients` needed one because a soft delete
 *    there leaves the address reserved by a row nobody can reach. An account
 *    delete rewrites the address to a per-row tombstone instead, so the global
 *    constraint keeps meaning what it says and registering that email again works
 *    without touching the index.
 *  - **`users` stays out of the purge job.** `SoftDeletePurgeService` hard-deletes
 *    rows past the retention window, and for a user row that is the tenant
 *    cascade above, now thirty days later and without anybody watching. The
 *    tombstone is the record that the account was deleted, not content in a
 *    trash.
 *
 * Nothing is `NOT NULL` and nothing has a default, so the migration is
 * non-blocking: every existing row reads as live without a rewrite.
 */
export class AccountDeletion1700000000005 implements MigrationInterface {
  name = 'AccountDeletion1700000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN "deleted_at" TIMESTAMP
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN "deleted_at"
    `);
  }
}
