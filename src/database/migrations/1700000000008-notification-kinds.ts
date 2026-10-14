import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The notifications table becomes the "what's new in the system" feed.
 *
 * The first project-management migration shipped a three-kind inbox
 * (assignments and status changes) constrained by `CHK_notifications_kind`.
 * Lifecycle events -- task/subtask/milestone created, updated, deleted, and
 * milestone restored -- are added beside them, and `actor_id` records who did
 * the thing each row reports, so a recipient can tell a colleague's change
 * from a system one. The constraint keeps the database agreeing with
 * `NOTIFICATION_KINDS`, the same way it did on day one.
 */
export class NotificationKinds1700000000008 implements MigrationInterface {
  name = 'NotificationKinds1700000000008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notifications" DROP CONSTRAINT "CHK_notifications_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "notifications"
         ADD CONSTRAINT "CHK_notifications_kind" CHECK (
           "kind" IN (
             'task.assigned', 'task.status_changed',
             'task.created', 'task.updated', 'task.deleted',
             'subtask.assigned',
             'subtask.created', 'subtask.updated', 'subtask.deleted',
             'milestone.created', 'milestone.updated', 'milestone.deleted',
             'milestone.restored'
           )
         )`,
    );

    await queryRunner.query(
      `ALTER TABLE "notifications" ADD COLUMN "actor_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "notifications"
         ADD CONSTRAINT "FK_notifications_actor" FOREIGN KEY ("actor_id")
         REFERENCES "users" ("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notifications_actor" ON "notifications" ("actor_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_notifications_actor"`);
    await queryRunner.query(
      `ALTER TABLE "notifications" DROP CONSTRAINT "FK_notifications_actor"`,
    );
    await queryRunner.query(
      `ALTER TABLE "notifications" DROP COLUMN "actor_id"`,
    );

    await queryRunner.query(
      `ALTER TABLE "notifications" DROP CONSTRAINT "CHK_notifications_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "notifications"
         ADD CONSTRAINT "CHK_notifications_kind" CHECK (
           "kind" IN ('task.assigned', 'subtask.assigned', 'task.status_changed')
         )`,
    );
  }
}