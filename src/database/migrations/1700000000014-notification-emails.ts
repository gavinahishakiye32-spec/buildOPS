import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The notification-email outbox.
 *
 * One row per email that has to be delivered, written in the same transaction
 * as the notification it announces. Delivery is then a durable, retryable job
 * rather than a `sendMail` fired from inside a request: a row can be claimed,
 * retried with a backoff, and finally marked `failed`, and every one of those
 * transitions is queryable instead of being a log line.
 *
 * `next_attempt_at` doubles as the backoff timer and as the claim lease, so the
 * one index that matters is partial: the worker only ever asks for `pending`
 * rows whose time has come. A table that accrues a row per notification forever
 * would otherwise pay to skip the sent and failed ones on every poll.
 *
 * `notification_id` cascades so an email goes when the notification it is about
 * is purged; `user_id` is `SET NULL` because the address is already copied onto
 * the row and the record that an email was owed must outlive the account.
 */
export class NotificationEmails1700000000014 implements MigrationInterface {
  name = 'NotificationEmails1700000000014';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "notification_emails" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "notification_id" uuid,
        "user_id" uuid,
        "to_email" character varying(255) NOT NULL,
        "subject" character varying(255) NOT NULL,
        "body" text NOT NULL,
        "link" character varying(512),
        "status" character varying(20) NOT NULL DEFAULT 'pending',
        "attempts" integer NOT NULL DEFAULT 0,
        "max_attempts" integer NOT NULL DEFAULT 5,
        "next_attempt_at" TIMESTAMP NOT NULL DEFAULT now(),
        "last_error" text,
        "sent_at" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notification_emails" PRIMARY KEY ("id"),
        CONSTRAINT "FK_notification_emails_notification" FOREIGN KEY ("notification_id")
          REFERENCES "notifications" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_notification_emails_user" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE SET NULL
      )
    `);

    // The worker's one query: due, pending rows, oldest first. Partial so the
    // rows that are already sent or dead cost nothing to skip.
    await queryRunner.query(`
      CREATE INDEX "IDX_notification_emails_due"
      ON "notification_emails" ("next_attempt_at")
      WHERE "status" = 'pending'
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_notification_emails_user" ON "notification_emails" ("user_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_notification_emails_user"`);
    await queryRunner.query(`DROP INDEX "IDX_notification_emails_due"`);
    await queryRunner.query(`DROP TABLE "notification_emails"`);
  }
}
