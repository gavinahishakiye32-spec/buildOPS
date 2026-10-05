import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Refresh tokens and the session lineage they form.
 *
 * Auth had no session layer at all: a single stateless access token, no refresh,
 * no logout, and no way to invalidate a token that leaked. Nothing here changes
 * that token's shape on the wire -- this migration only adds the storage that
 * makes revocation, rotation and reuse detection possible.
 *
 * `family_id` is the important column. A refresh revokes the presented token and
 * issues a new one in the same family, so a token that is presented again after
 * being rotated is a replay of a stolen copy rather than a slow client, and the
 * whole family can be revoked in response. Keeping the lineage in the schema is
 * what makes that check a single indexed query instead of a walk over history.
 *
 * `token_hash` is unique and indexed because every refresh resolves by it, and
 * the token is stored hashed for the same reason the password-reset token is: a
 * database copy must not be replayable against the API.
 *
 * The foreign key cascades on user deletion. That is the one delete in the schema
 * that is meant to remove rows: a session belonging to an account that no longer
 * exists is not data anyone can be harmed by losing.
 */
export class RefreshTokens1700000000002 implements MigrationInterface {
  name = 'RefreshTokens1700000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "refresh_tokens" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "token_hash" char(64) NOT NULL,
        "family_id" uuid NOT NULL,
        "expires_at" TIMESTAMP NOT NULL,
        "revoked_at" TIMESTAMP,
        "revoked_reason" character varying(40),
        "replaced_by_id" uuid,
        "user_agent" character varying(255),
        "ip" character varying(45),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_refresh_tokens_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_refresh_tokens_token_hash" UNIQUE ("token_hash"),
        CONSTRAINT "FK_refresh_tokens_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens" ("family_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens" ("user_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "refresh_tokens_user_id_idx"`);
    await queryRunner.query(`DROP INDEX "refresh_tokens_family_id_idx"`);
    await queryRunner.query(`DROP TABLE "refresh_tokens"`);
  }
}
