import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Soft deletion for user-authored content.
 *
 * The baseline migration left this column out on purpose, and the reason is
 * worth restating because it is the whole justification for this one. Every
 * delete before this was a `DELETE FROM`, and the damage spread through fourteen
 * `ON DELETE CASCADE` foreign keys rather than through application code. That
 * made `DELETE /organizations/:id` a single request that erased an entire
 * tenant, and deleting one subtask erased the hours logged against it -- hours
 * that are a business record, not a cache. None of it was recoverable, and
 * nothing recorded who had done it.
 *
 * `deleted_at` turns those deletes into a flag. Because the row is still there,
 * the restore endpoint can bring a whole subtree back exactly as it was, and
 * `deleted_by` answers the question an admin will ask first, which is who.
 *
 * Three decisions that are easy to get wrong:
 *
 *  - **The cascade is no longer the database's job.** With `deleted_at`, a
 *    database cascade never fires, because nothing is actually removed. The
 *    application walks the tree instead, so that soft-deleting a project also
 *    soft-deletes its tasks and their subtasks. Leaving that to Postgres would
 *    hide rows that are still reachable through a parent that is gone, and a
 *    restore would produce a project with a hole in it.
 *
 *  - **`UQ_clients_email` becomes a partial index.** It was a global unique
 *    constraint, and a global one plus soft deletion means an address stays
 *    reserved forever by a client that was deleted months ago. Scoping the
 *    index to live rows keeps the constraint that actually matters -- two live
 *    clients cannot share an address -- without making a deleted row a permanent
 *    obstacle. The entity's `@Index({ unique: true })` on that column has to go,
 *    or TypeORM's schema diff will keep proposing the constraint back.
 *
 *  - **The new indexes are partial.** These are the parent lookups the cascade
 *    walk and the list queries both run, and they run on every list page. A
 *    partial index over live rows stays small no matter how much has been
 *    deleted, whereas adding `deleted_at` as a trailing column on the existing
 *    indexes would still scan every deleted row in the table.
 *
 * Declaring `deleted_at` as a `@DeleteDateColumn` rather than a bare column is
 * what makes this work without touching a single existing read. TypeORM then
 * filters the row out of `find`, `findOne`, `count`, `getCount` and every
 * joined alias of a query builder -- verified against PostgreSQL for both
 * entity-class and string joins, inner and left -- and `softDelete`/`restore`
 * become available on the repository. Hand-written SQL through
 * `DataSource.query` is the only thing it does not reach, and none of these
 * tables are read that way.
 *
 * `organizations` is deliberately absent. Deleting a tenant is not a content
 * edit, it is the end of the account, and the guard for that is a confirmation
 * requirement on the route rather than a recoverable flag -- see
 * `OrganizationService.remove`.
 *
 * Nothing here is `NOT NULL` and nothing has a default, so the migration is
 * non-blocking: existing rows read as live without a rewrite.
 */
export class SoftDeletes1700000000003 implements MigrationInterface {
  name = 'SoftDeletes1700000000003';

  private static readonly SOFT_DELETE_TABLES = [
    'clients',
    'projects',
    'tasks',
    'subtasks',
    'time_entries',
    'badges',
    'teams',
  ] as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of SoftDeletes1700000000003.SOFT_DELETE_TABLES) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          ADD COLUMN "deleted_at" TIMESTAMP
      `);

      // Recorded rather than inferred. A soft delete is the one destructive
      // action a user can still take against shared content, so "who did this"
      // has to be answerable from the row itself.
      //
      // `SET NULL` rather than `CASCADE`: the audit trail must outlive the
      // account that created it, and a deleted user is not a reason to forget
      // that they emptied a project.
      await queryRunner.query(`
        ALTER TABLE "${table}"
          ADD COLUMN "deleted_by" uuid,
          ADD CONSTRAINT "FK_${table}_deleted_by"
          FOREIGN KEY ("deleted_by")
          REFERENCES "users" ("id") ON DELETE SET NULL
      `);
    }

    // The cascade walk and every list query look a child up by its parent, so
    // these four are the indexes that keep soft deletion from turning into a
    // full scan as the deleted set grows.
    await queryRunner.query(`
      CREATE INDEX "IDX_projects_org_live"
        ON "projects" ("organization_id") WHERE "deleted_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_tasks_project_live"
        ON "tasks" ("project_id") WHERE "deleted_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_subtasks_task_live"
        ON "subtasks" ("task_id") WHERE "deleted_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_time_entries_subtask_live"
        ON "time_entries" ("subtask_id") WHERE "deleted_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_teams_org_live"
        ON "teams" ("organization_id") WHERE "deleted_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_badges_org_live"
        ON "badges" ("organization_id") WHERE "deleted_at" IS NULL
    `);

    // A deleted client must stop reserving its address, or re-creating a client
    // with an address somebody deleted last quarter is a 409 for a row that is
    // not even visible any more.
    await queryRunner.query(
      `ALTER TABLE "clients" DROP CONSTRAINT "UQ_clients_email"`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_clients_email_live"
        ON "clients" ("email") WHERE "deleted_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // A partial index cannot be restored into the global constraint unless the
    // data actually satisfies it, so check before trying rather than failing a
    // rollback halfway with a constraint violation.
    const { rows } = await queryRunner.query(`
      SELECT "email", COUNT(*) AS "live"
      FROM "clients"
      WHERE "deleted_at" IS NULL AND "email" IS NOT NULL
      GROUP BY "email"
      HAVING COUNT(*) > 1
    `);

    if (rows.length > 0) {
      throw new Error(
        `Cannot revert soft deletes: ${rows.length} client email(s) are held by more than one live client, which the restored global unique constraint forbids.`,
      );
    }

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_clients_email"
        ON "clients" ("email")
    `);
    await queryRunner.query(`DROP INDEX "UQ_clients_email_live"`);

    for (const index of [
      'IDX_badges_org_live',
      'IDX_teams_org_live',
      'IDX_time_entries_subtask_live',
      'IDX_subtasks_task_live',
      'IDX_tasks_project_live',
      'IDX_projects_org_live',
    ]) {
      await queryRunner.query(`DROP INDEX "${index}"`);
    }

    for (const table of SoftDeletes1700000000003.SOFT_DELETE_TABLES) {
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP CONSTRAINT "FK_${table}_deleted_by"`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP COLUMN "deleted_by", DROP COLUMN "deleted_at"`,
      );
    }
  }
}
