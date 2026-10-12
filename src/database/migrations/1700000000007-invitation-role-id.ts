import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Let an invitation name the role it grants, instead of only a template.
 *
 * An invitation used to carry `template_key`, so acceptance had nothing to grant
 * but one of the five built-in templates: it called `addMember`, which creates
 * a **new** `roles` row from that template's permission list. Two things went
 * wrong from there, and both were visible in the product.
 *
 *  - **A custom role could not travel.** An administrator who built a role for
 *    somebody — "tasks and the timer only", say — and invited them got the
 *    built-in `developer` template instead, which also carries `client.view`,
 *    `project.view`, `dashboard.view` and `settings.view`. The invitee saw CRM,
 *    Projects, Analytics, Finance and Integrations they were never meant to.
 *    The name made it worse: the frontend matched roles to templates *by name*,
 *    so a custom role called "Developer" was indistinguishable from the
 *    template and was silently sent as one.
 *
 *  - **Accepting duplicated the role.** Creating a row per acceptance meant an
 *    organization that already had a role called "Developer" ended up with two
 *    of them on the Roles & Permissions screen, one carrying the real
 *    permissions and one nobody could tell apart.
 *
 * `role_id` is the actual fix: the invitation now remembers which `roles` row it
 * is granting, and acceptance *hands that row over* instead of manufacturing a
 * replacement. A role with `user_id IS NULL` is by this product's own
 * definition a definition waiting to be handed out, so this reuses the model
 * that already exists rather than adding a second one.
 *
 * Nullable, and deliberately so. `template_key` is kept and still does the work
 * whenever `role_id` is null — which is every row written before this migration,
 * and every caller that has no role to name. Nothing that worked stops working,
 * and the fallback is the old behaviour rather than a new failure mode.
 *
 * The FK is `ON DELETE SET NULL`, not `CASCADE`: deleting a role that was
 * promised to somebody should not delete the promise. The invitation survives
 * and falls back to its template, which is exactly the old behaviour and is
 * preferable to an invitation that cannot be accepted at all.
 */
export class InvitationRoleId1700000000007 implements MigrationInterface {
  name = 'InvitationRoleId1700000000007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organization_invitations" ADD "role_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "organization_invitations" ADD CONSTRAINT "FK_invitations_role" FOREIGN KEY ("role_id") REFERENCES "roles" ("id") ON DELETE SET NULL`,
    );
    // Looked up by organization on every render of the invitations list.
    await queryRunner.query(
      `CREATE INDEX "IDX_invitations_role_id" ON "organization_invitations" ("role_id") WHERE "role_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_invitations_role_id"`);
    await queryRunner.query(
      `ALTER TABLE "organization_invitations" DROP CONSTRAINT "FK_invitations_role"`,
    );
    await queryRunner.query(`ALTER TABLE "organization_invitations" DROP COLUMN "role_id"`);
  }
}
