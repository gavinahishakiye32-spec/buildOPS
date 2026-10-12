import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Assignment lookups.
 *
 * Assignment lives on the *subtask*, never on the task: a task is the piece of
 * work, and the people doing it are named on the steps underneath it. Naming
 * one owner for a task and then splitting the work three ways is two answers to
 * one question, and the task-level one is the one that goes stale.
 *
 * Two changes, both in service of "who is doing what":
 *
 * 1. `IDX_subtasks_assigned_to` — the assigned-work feed filters on
 *    `assigned_to`, and there was no index on it: `subtasks` is joined by
 *    `task_id` only, so "my work" was a sequential scan of every subtask in
 *    the organization.
 * 2. `UQ_roles_organization_user_live` — the membership check behind
 *    assignment (`organization_id` + `user_id` + `status = 'active'`) ran on
 *    `IDX_roles_organization_id` and then filtered. A composite index makes it
 *    a lookup, and it also records an invariant that was only enforced in
 *    application code: one live membership row per person per organization.
 *
 */
export class TaskAssignment1700000000009 implements MigrationInterface {
  name = 'TaskAssignment1700000000009';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_subtasks_assigned_to" ON "subtasks" ("assigned_to")`,
    );

    // One live membership per person per organization. `deactivated` rows are
    // kept on purpose -- reactivation restores the role -- so the uniqueness has
    // to be scoped to the live ones rather than covering the whole table.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_roles_organization_user_live"
      ON "roles" ("organization_id", "user_id")
      WHERE "user_id" IS NOT NULL AND "status" = 'active'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "UQ_roles_organization_user_live"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_subtasks_assigned_to"`);
  }
}