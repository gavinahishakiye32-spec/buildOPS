import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Removes `tasks.assignee_id`.
 *
 * An earlier draft of `TaskAssignment1700000000009` gave every task an owner,
 * alongside the assignee its subtasks already carried. That was two answers to
 * one question — a task with one owner whose work is then split three ways — and
 * the task-level one is the one that goes stale the moment a step is handed to
 * somebody else. Assignment belongs on the step.
 *
 * Written as a follow-up rather than an edit to the migration above because that
 * migration has already run in at least one environment: changing it would not
 * undo the column there, and TypeORM records migrations by name so an edited one
 * is simply skipped. Both `IF EXISTS` clauses are load-bearing — a database
 * created from the corrected migration above never had the column at all.
 */
export class DropTaskAssignee1700000000010 implements MigrationInterface {
  name = 'DropTaskAssignee1700000000010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "FK_tasks_assignee_to"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_tasks_assignee_id"`);
    await queryRunner.query(
      `ALTER TABLE "tasks" DROP COLUMN IF EXISTS "assignee_id"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restoring the column is deliberately empty of data: there is no honest way
    // to repopulate an owner from subtask assignees, because a task with steps
    // spread across three people had no single owner to begin with.
    await queryRunner.query(`ALTER TABLE "tasks" ADD "assignee_id" uuid`);
    await queryRunner.query(`
      ALTER TABLE "tasks"
      ADD CONSTRAINT "FK_tasks_assignee_to"
      FOREIGN KEY ("assignee_id")
      REFERENCES "users" ("id") ON DELETE SET NULL
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_tasks_assignee_id" ON "tasks" ("assignee_id")`,
    );
  }
}