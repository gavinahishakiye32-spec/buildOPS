import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Roles remember the role template they were created from.
 *
 * A `roles` row carried no template identity: the five default templates were
 * told apart by their display name alone, which conflated the template a role
 * was born from with the label a human gave it. The `key` column records the
 * template (`owner`, `project_manager`, ..., null for ad-hoc roles created with
 * POST /roles) as provenance: an administrator sees where a role came from, and
 * tooling that needs the template no longer has to guess from a name that is
 * freely editable. Rows that predate the column are backfilled from the
 * template names they already carry.
 */
export class RoleTemplateKeys1700000000009 implements MigrationInterface {
  name = 'RoleTemplateKeys1700000000009';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "roles" ADD COLUMN "key" character varying(50)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_roles_organization_key" ON "roles" ("organization_id", "key")`,
    );

    await queryRunner.query(`
      UPDATE "roles" SET "key" = CASE "name"
        WHEN 'Owner'            THEN 'owner'
        WHEN 'Project Manager'  THEN 'project_manager'
        WHEN 'Developer'        THEN 'developer'
        WHEN 'Tester'           THEN 'tester'
        WHEN 'Viewer'           THEN 'viewer'
      END
      WHERE "name" IN ('Owner', 'Project Manager', 'Developer', 'Tester', 'Viewer')
        AND "key" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_roles_organization_key"`);
    await queryRunner.query(`ALTER TABLE "roles" DROP COLUMN "key"`);
  }
}