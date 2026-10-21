import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Activity events: the append-only "who did what" trail behind the analytics
 * endpoints (spec §21).
 *
 * Written in the same transaction as the mutation it describes, so the feed is
 * consistent with the data it reports on: a failed write leaves no orphan event
 * and a successful one always has one. `entity_id` carries no foreign key —
 * events must outlive the rows they describe (chat channels are hard-deleted
 * with their scope, for instance) — while `actor_id` and `project_id` are
 * `SET NULL`: a removed user or project degrades to "system / unscoped"
 * instead of taking the event with it. `organization_id` is `CASCADE`, because
 * an event has no meaning without its tenant.
 *
 * The CHECK constraints mirror `ACTIVITY_ENTITY_TYPES` and `ACTIVITY_ACTIONS`
 * in `activity.entity.ts`, so the database and the closed sets in the code
 * cannot drift apart.
 *
 * The permission is seeded into the roles created before this migration the
 * same way the chat and milestones migrations do it, matched on the display
 * name `RoleService` uses. New organizations need none of that: the running
 * code builds the template permissions at creation time.
 */
export class Activity1700000000016 implements MigrationInterface {
  name = 'Activity1700000000016';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "activity_events" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "organization_id" uuid NOT NULL,
      "actor_id" uuid,
      "entity_type" character varying(32) NOT NULL,
      "action" character varying(16) NOT NULL,
      "entity_id" uuid NOT NULL,
      "project_id" uuid,
      "metadata" jsonb,
      "created_at" TIMESTAMP NOT NULL DEFAULT now(),
      CONSTRAINT "PK_activity_events" PRIMARY KEY ("id"),
      CONSTRAINT "FK_activity_events_organization" FOREIGN KEY ("organization_id")
        REFERENCES "organizations" ("id") ON DELETE CASCADE,
      CONSTRAINT "FK_activity_events_actor" FOREIGN KEY ("actor_id")
        REFERENCES "users" ("id") ON DELETE SET NULL,
      CONSTRAINT "FK_activity_events_project" FOREIGN KEY ("project_id")
        REFERENCES "projects" ("id") ON DELETE SET NULL,
      CONSTRAINT "CHK_activity_events_entity_type" CHECK ("entity_type" IN (
        'project', 'task', 'subtask', 'milestone', 'team', 'client', 'badge',
        'time_entry', 'chat_message', 'chat_channel', 'invitation', 'role',
        'member'
      )),
      CONSTRAINT "CHK_activity_events_action" CHECK ("action" IN (
        'created', 'updated', 'deleted', 'restored', 'accepted'
      ))
    )`);

    // The four indexes match the filters the analytics endpoints run: the whole
    // feed, per-actor, per-entity-type/action and per-project, always scoped to
    // the organization and ordered by recency.
    await queryRunner.query(
      `CREATE INDEX "IDX_activity_events_org_created"
         ON "activity_events" ("organization_id", "created_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_activity_events_org_actor"
         ON "activity_events" ("organization_id", "actor_id", "created_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_activity_events_org_entity"
         ON "activity_events" ("organization_id", "entity_type", "action", "created_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_activity_events_org_project"
         ON "activity_events" ("organization_id", "project_id", "created_at" DESC)`,
    );

    await queryRunner.query(`
      WITH template_permissions(template_name, permission_name, permission_description) AS (
        VALUES
          ('Owner',           'analytics.view', 'view analytics'),
          ('Project Manager', 'analytics.view', 'view analytics'),
          ('Developer',       'analytics.view', 'view analytics'),
          ('Tester',          'analytics.view', 'view analytics'),
          ('Viewer',          'analytics.view', 'view analytics')
      )
      INSERT INTO "permissions" ("id", "role_id", "name", "description", "created_at", "updated_at")
      SELECT gen_random_uuid(), r."id", tp.permission_name, tp.permission_description, now(), now()
      FROM "roles" r
      JOIN template_permissions tp ON tp.template_name = r."name"
      WHERE NOT EXISTS (
        SELECT 1 FROM "permissions" p WHERE p."role_id" = r."id" AND p."name" = tp.permission_name
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "permissions"
      WHERE "name" = 'analytics.view'
      AND "role_id" IN (
        SELECT "id" FROM "roles"
        WHERE "name" IN ('Owner', 'Project Manager', 'Developer', 'Tester', 'Viewer')
      )
    `);

    await queryRunner.query(`DROP INDEX "IDX_activity_events_org_project"`);
    await queryRunner.query(`DROP INDEX "IDX_activity_events_org_entity"`);
    await queryRunner.query(`DROP INDEX "IDX_activity_events_org_actor"`);
    await queryRunner.query(`DROP INDEX "IDX_activity_events_org_created"`);
    await queryRunner.query(`DROP TABLE "activity_events"`);
  }
}
