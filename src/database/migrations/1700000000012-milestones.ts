import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Project milestones.
 *
 * A milestone is a soft-deletable phase calendar for a project, and
 * `tasks.milestone_id` groups tasks under it. The foreign key is
 * `ON DELETE SET NULL`: a deleted milestone must not take the tasks scheduled
 * against it with it. The status check lives on the table (like the other
 * closed-value columns) so the database and the validators cannot drift apart.
 *
 * New permissions are also seeded into the role definitions and memberships
 * that were created before this migration, matched by the template display
 * name the way `RoleService` names them (`Owner`, `Project Manager`, ...), so
 * an existing organization starts being able to run milestones without
 * anybody re-creating a role by hand. New organizations need none of that: the
 * running code builds the template permissions at creation time.
 *
 * The permission descriptions mirror `RoleService.describePermission`
 * (`<action> <resource>`).
 */
export class Milestones1700000000012 implements MigrationInterface {
  name = 'Milestones1700000000012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "milestones" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "organization_id" uuid NOT NULL,
      "project_id" uuid NOT NULL,
      "name" character varying(255) NOT NULL,
      "description" text,
      "status" character varying(50) NOT NULL DEFAULT 'planned',
      "due_date" DATE,
      "created_at" TIMESTAMP NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
      "deleted_at" TIMESTAMP,
      "deleted_by" uuid,
      CONSTRAINT "PK_milestones" PRIMARY KEY ("id"),
      CONSTRAINT "FK_milestones_organization" FOREIGN KEY ("organization_id")
        REFERENCES "organizations" ("id") ON DELETE CASCADE,
      CONSTRAINT "FK_milestones_project" FOREIGN KEY ("project_id")
        REFERENCES "projects" ("id") ON DELETE CASCADE,
      CONSTRAINT "CHK_milestones_status"
        CHECK ("status" IN ('planned', 'in_progress', 'completed', 'cancelled'))
    )`);

    await queryRunner.query(
      `CREATE INDEX "IDX_milestones_organization_id"
         ON "milestones" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_milestones_project_id" ON "milestones" ("project_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_milestones_status" ON "milestones" ("status")`,
    );

    await queryRunner.query(
      `ALTER TABLE "tasks"
         ADD COLUMN "milestone_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "tasks"
         ADD CONSTRAINT "FK_tasks_milestone" FOREIGN KEY ("milestone_id")
         REFERENCES "milestones" ("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_tasks_milestone_id" ON "tasks" ("milestone_id")`,
    );

    // Existing roles gain the permissions the templates now describe. Matching
    // on the display name rather than on a template key, because roles do not
    // store a key -- but only the five template names are touched, and only the
    // permissions the templates list, so a custom role is left alone.
    await queryRunner.query(`
      WITH template_permissions(template_name, permission_name, permission_description) AS (
        VALUES
          ('Owner',             'milestone.view',        'view milestone'),
          ('Owner',             'milestone.create',      'create milestone'),
          ('Owner',             'milestone.update',      'update milestone'),
          ('Owner',             'milestone.delete',      'delete milestone'),
          ('Owner',             'notification.view',     'view notification'),
          ('Owner',             'notification.update',   'update notification'),
          ('Owner',             'notification.delete',   'delete notification'),
          ('Project Manager',   'milestone.view',        'view milestone'),
          ('Project Manager',   'milestone.create',      'create milestone'),
          ('Project Manager',   'milestone.update',      'update milestone'),
          ('Project Manager',   'milestone.delete',      'delete milestone'),
          ('Project Manager',   'notification.view',     'view notification'),
          ('Project Manager',   'notification.update',   'update notification'),
          ('Project Manager',   'notification.delete',   'delete notification'),
          ('Developer',         'milestone.view',        'view milestone'),
          ('Developer',         'notification.view',     'view notification'),
          ('Developer',         'notification.update',   'update notification'),
          ('Developer',         'notification.delete',   'delete notification'),
          ('Tester',            'milestone.view',        'view milestone'),
          ('Tester',            'notification.view',     'view notification'),
          ('Tester',            'notification.update',   'update notification'),
          ('Tester',            'notification.delete',   'delete notification'),
          ('Viewer',            'milestone.view',        'view milestone'),
          ('Viewer',            'notification.view',     'view notification')
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
    // The mirror of the seeding: remove the new permissions from the roles that
    // this migration gave them to.
    await queryRunner.query(`
      DELETE FROM "permissions"
      WHERE "name" IN (
        'milestone.view', 'milestone.create', 'milestone.update',
        'milestone.delete', 'notification.view',
        'notification.update', 'notification.delete'
      )
      AND "role_id" IN (
        SELECT "id" FROM "roles"
        WHERE "name" IN ('Owner', 'Project Manager', 'Developer', 'Tester', 'Viewer')
      )
    `);

    await queryRunner.query(`DROP INDEX "IDX_tasks_milestone_id"`);
    await queryRunner.query(
      `ALTER TABLE "tasks" DROP CONSTRAINT "FK_tasks_milestone"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tasks" DROP COLUMN "milestone_id"`,
    );

    await queryRunner.query(`DROP INDEX "IDX_milestones_status"`);
    await queryRunner.query(`DROP INDEX "IDX_milestones_project_id"`);
    await queryRunner.query(`DROP INDEX "IDX_milestones_organization_id"`);
    await queryRunner.query(`DROP TABLE "milestones"`);
  }
}
