import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Invitations by email, and a deactivatable membership.
 *
 * Two related changes, because they answer the same question: what happens to a
 * member who should not have access right now but must be able to get it back.
 *
 *  - **`roles.status` is the deactivation flag.** A role row *is* the membership
 *    (spec §6: one assigned role per member per organization), so the flag lives
 *    there rather than on `users`: an account can be a member of several
 *    organizations, and suspending it for one must not suspend it everywhere.
 *    `PermissionsGuard` resolves through `RoleService.resolve`, so filtering on
 *    `status = 'active'` there is what turns the flag into lost access -- one
 *    query, no guard to teach. The column is `NOT NULL DEFAULT 'active'`, so
 *    every existing membership keeps working and a direct read never sees a null
 *    to interpret.
 *
 *    A deactivated member still holds their seat on purpose. Deactivation is a
 *    suspension, not a removal: the role, its permissions and the history stay
 *    intact so `activate` can put them back exactly as they were, and a plan
 *    whose capacity oscillated with every suspension would be impossible to
 *    reason about. `DELETE /members/:userId` remains the operation that frees a
 *    seat.
 *
 *  - **`organization_invitations` holds an invitation until it is accepted.**
 *    The invitee may not have an account yet, so there is nothing to attach the
 *    role to at invite time -- the row stores who was invited, under which role
 *    template, and the hash of the token that was emailed to them. The raw token
 *    never touches the database, the same way verification and reset tokens
 *    never do: the email is the only place it exists.
 *
 *    The unique index on `(organization_id, email)` is partial, over `pending`
 *    rows only. A global one would keep an address reserved forever by an
 *    invitation that expired last quarter, which is exactly the mistake
 *    `SoftDeletes1700000000003` corrected for client emails. Accepted and
 *    revoked rows stay for history and must not block a re-invite.
 *
 * `email` is stored normalized (trimmed, lowercased) by the service before it is
 * written, so the partial unique index sees one spelling of an address.
 */
export class MemberInvitations1700000000006 implements MigrationInterface {
  name = 'MemberInvitations1700000000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "roles"
        ADD COLUMN "status" varchar(20) NOT NULL DEFAULT 'active'
    `);

    await queryRunner.query(`
      ALTER TABLE "roles"
        ADD CONSTRAINT "CHK_roles_status"
        CHECK ("status" IN ('active', 'deactivated'))
    `);

    // The guard reads this on every organization-scoped request, so it is a
    // partial index over live memberships: a role definition (`user_id IS NULL`)
    // or a deactivated row is not worth carrying in it.
    await queryRunner.query(`
      CREATE INDEX "IDX_roles_org_member_live"
        ON "roles" ("organization_id", "user_id")
        WHERE "status" = 'active'
    `);

    await queryRunner.query(`
      CREATE TABLE "organization_invitations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "organization_id" uuid NOT NULL,
        "email" character varying(255) NOT NULL,
        "template_key" character varying(50) NOT NULL,
        "role_name" character varying(255) NOT NULL,
        "token_hash" character varying(64) NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'pending',
        "expires_at" timestamp NOT NULL,
        "invited_by" uuid,
        "accepted_at" timestamp,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_organization_invitations" PRIMARY KEY ("id"),
        CONSTRAINT "FK_organization_invitations_organization"
          FOREIGN KEY ("organization_id")
          REFERENCES "organizations" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_organization_invitations_invited_by"
          FOREIGN KEY ("invited_by")
          REFERENCES "users" ("id") ON DELETE SET NULL,
        CONSTRAINT "CHK_organization_invitations_status"
          CHECK ("status" IN ('pending', 'accepted', 'revoked'))
      )
    `);

    // A token hash is compared verbatim on every accept, so it is unique across
    // the table rather than per organization: the lookup never has the
    // organization id to narrow with.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_organization_invitations_token"
        ON "organization_invitations" ("token_hash")
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_organization_invitations_pending_email"
        ON "organization_invitations" ("organization_id", "email")
        WHERE "status" = 'pending'
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_organization_invitations_org"
        ON "organization_invitations" ("organization_id")
        WHERE "status" = 'pending'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "organization_invitations"`);
    await queryRunner.query(`DROP INDEX "IDX_roles_org_member_live"`);
    await queryRunner.query(
      `ALTER TABLE "roles" DROP CONSTRAINT "CHK_roles_status"`,
    );
    await queryRunner.query(`ALTER TABLE "roles" DROP COLUMN "status"`);
  }
}
