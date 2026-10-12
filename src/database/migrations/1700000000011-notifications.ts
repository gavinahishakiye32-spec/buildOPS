import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * In-app notifications.
 *
 * One row per thing worth telling somebody about, addressed to exactly one
 * recipient. `user_id` is the recipient and is never taken from a request body:
 * a notification is written by the action that caused it, and the API's job is
 * to decide who that lands on.
 *
 * `read_at` rather than a boolean, because "when did you see it" is the only
 * question a bell icon actually asks, and a flag cannot answer it.
 *
 * The partial index on `read_at IS NULL` is what the unread badge counts. A
 * member of a busy organization accrues notifications indefinitely and reads a
 * handful, so the count is always "unseen rows for me" over the whole table —
 * the one query that would degrade without it.
 */
export class Notifications1700000000011 implements MigrationInterface {
  name = 'Notifications1700000000011';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "notifications" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "organization_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "type" character varying(50) NOT NULL DEFAULT 'subtask_assigned',
        "title" character varying(255) NOT NULL,
        "body" text,
        "task_id" uuid,
        "subtask_id" uuid,
        "actor_id" uuid,
        "read_at" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notifications" PRIMARY KEY ("id"),
        CONSTRAINT "FK_notifications_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_notifications_user" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_notifications_task" FOREIGN KEY ("task_id")
          REFERENCES "tasks" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_notifications_subtask" FOREIGN KEY ("subtask_id")
          REFERENCES "subtasks" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_notifications_actor" FOREIGN KEY ("actor_id")
          REFERENCES "users" ("id") ON DELETE SET NULL
      )
    `);

    // The list route: "my notifications, newest first". Covers the badge count
    // and the dropdown in one index.
    await queryRunner.query(
      `CREATE INDEX "IDX_notifications_user_recent" ON "notifications" ("user_id", "created_at" DESC)`,
    );

    // The unread badge alone, so a member who has read everything for a year
    // does not still pay to scan it.
    await queryRunner.query(`
      CREATE INDEX "IDX_notifications_unread"
      ON "notifications" ("user_id", "created_at" DESC)
      WHERE "read_at" IS NULL
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_notifications_organization" ON "notifications" ("organization_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_notifications_organization"`);
    await queryRunner.query(`DROP INDEX "IDX_notifications_unread"`);
    await queryRunner.query(`DROP INDEX "IDX_notifications_user_recent"`);
    await queryRunner.query(`DROP TABLE "notifications"`);
  }
}