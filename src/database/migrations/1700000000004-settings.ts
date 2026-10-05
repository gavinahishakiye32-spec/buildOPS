import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-user preferences and per-organization settings.
 *
 * Three decisions worth stating, because each of them has a version that looks
 * simpler and is worse.
 *
 *  - **The foreign key is the primary key.** One row per user, one per
 *    organization, for as long as the owner exists. With a generated `id` the
 *    uniqueness would have to be a separate constraint on `user_id` anyway, so
 *    the surrogate key would add a column and a constraint and buy nothing.
 *    It also closes the race two concurrent first-reads would otherwise have: a
 *    unique primary key makes the second insert fail rather than produce a
 *    second competing set of defaults, and the service resolves that by re-reading.
 *
 *  - **Every column is NOT NULL with a database default.** Nullable settings
 *    columns are the usual choice, and they are the reason settings endpoints
 *    tend to grow a merge-with-defaults layer in the service, plus a second
 *    definition of those defaults on the client so two readers can disagree.
 *    Here the row only exists once it is complete, so a direct database read
 *    returns a usable value and there is no "unset" state to interpret.
 *
 *  - **The CHECK constraints carry the closed value sets.** The enums live in
 *    `common/enums.ts` and the DTOs validate with `@IsIn` against the same
 *    arrays, so a documented value can never be one the validator rejects. A
 *    value written past the API would otherwise sit in the column unnoticed
 *    until a client read it back and could not decide what to render. These
 *    constraints are what stop that, and they are `NOT VALID`-free on purpose:
 *    the tables are new, so they are created with the constraints already
 *    checked and there is no existing data to grandfather.
 *
 * Neither table is soft-deletable. Settings are not user-authored content: there
 * is no draft, no shared view of a trash entry, and nothing worth recovering
 * that a member could not simply set again. A deleted user or organization takes
 * its row with it through `ON DELETE CASCADE`, which is the correct answer for
 * preferences that only mean something to somebody who still exists.
 *
 * `working_day_start_minutes` / `working_day_end_minutes` are minutes from
 * midnight rather than `HH:MM` strings so the working window is comparable as a
 * number when checking a logged duration against it.
 */
export class Settings1700000000004 implements MigrationInterface {
  name = 'Settings1700000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "user_settings" (
        "user_id" uuid NOT NULL,
        "theme" varchar(20) NOT NULL DEFAULT 'system',
        "locale" varchar(10) NOT NULL DEFAULT 'en',
        "timezone" varchar(64) NOT NULL DEFAULT 'UTC',
        "date_format" varchar(20) NOT NULL DEFAULT 'YYYY-MM-DD',
        "time_format" varchar(10) NOT NULL DEFAULT '24h',
        "digest_frequency" varchar(20) NOT NULL DEFAULT 'daily',
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_settings" PRIMARY KEY ("user_id"),
        CONSTRAINT "FK_user_settings_user_id"
          FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_user_settings_theme"
          CHECK ("theme" IN ('system', 'light', 'dark')),
        CONSTRAINT "CHK_user_settings_locale"
          CHECK ("locale" IN ('en', 'fr', 'es', 'de', 'pt')),
        CONSTRAINT "CHK_user_settings_time_format"
          CHECK ("time_format" IN ('24h', '12h')),
        CONSTRAINT "CHK_user_settings_date_format"
          CHECK ("date_format" IN ('YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY')),
        CONSTRAINT "CHK_user_settings_digest_frequency"
          CHECK ("digest_frequency" IN ('realtime', 'daily', 'weekly', 'off'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "organization_settings" (
        "organization_id" uuid NOT NULL,
        "timezone" varchar(64) NOT NULL DEFAULT 'UTC',
        "week_start" varchar(10) NOT NULL DEFAULT 'monday',
        "time_format" varchar(10) NOT NULL DEFAULT '24h',
        "working_day_start_minutes" integer NOT NULL DEFAULT 540,
        "working_day_end_minutes" integer NOT NULL DEFAULT 1020,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_organization_settings" PRIMARY KEY ("organization_id"),
        CONSTRAINT "FK_organization_settings_organization_id"
          FOREIGN KEY ("organization_id")
          REFERENCES "organizations" ("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_organization_settings_week_start"
          CHECK ("week_start" IN ('monday', 'sunday')),
        CONSTRAINT "CHK_organization_settings_time_format"
          CHECK ("time_format" IN ('24h', '12h')),
        CONSTRAINT "CHK_organization_settings_working_window"
          CHECK (
            "working_day_start_minutes" >= 0
            AND "working_day_start_minutes" <= 1439
            AND "working_day_end_minutes" >= 0
            AND "working_day_end_minutes" <= 1439
            AND "working_day_start_minutes" < "working_day_end_minutes"
          )
      )
    `);

    // The two rows the primary key promises, written up front.
    //
    // Creating the table empty would have worked and the first read would have
    // materialized the defaults instead. Backfilling makes the rows exist for
    // every account that already does, so a client that reads settings through
    // any path other than this API -- a report, a support query, a direct
    // database read -- sees the same defaults rather than nothing at all. It is
    // an `INSERT ... SELECT` rather than a loop, so it does not depend on how
    // many accounts exist.
    await queryRunner.query(`
      INSERT INTO "user_settings" ("user_id")
      SELECT "id" FROM "users"
    `);

    await queryRunner.query(`
      INSERT INTO "organization_settings" ("organization_id")
      SELECT "id" FROM "organizations"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "organization_settings"`);
    await queryRunner.query(`DROP TABLE "user_settings"`);
  }
}
