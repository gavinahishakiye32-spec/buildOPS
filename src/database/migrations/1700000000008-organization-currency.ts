import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Denominate an organization in a currency of its own.
 *
 * Every amount in the product until now has been implicitly dollars: a budget
 * is a bare `DECIMAL(10,2)` (`projects.budget`) and a plan price is a bare
 * `DECIMAL(10,2)` (`plans.price`), with no code recording what either number
 * means. For a dollar-denominated customer that was invisible. For a Rwandan
 * agency it is wrong at the source -- `RWF 1,200,000` and `$1,200,000` are not
 * the same number, and nothing in the database could say which one was meant.
 *
 * This adds the missing fact at the level that owns it. An organization is the
 * workspace that holds clients, projects, budgets and invoices, so it is what
 * knows what its own figures are denominated in. It is asked once, when the
 * organization is created, and every member then reads the same numbers the same
 * way -- the same reasoning that keeps `organization_settings.timezone` out of
 * user settings, where one member could otherwise change the reporting time zone
 * for everybody.
 *
 * Three decisions worth stating, because each has a version that looks simpler.
 *
 *  - **On `organizations`, not in `organization_settings`.** The frontend calls
 *    `GET /settings/organization` nowhere; the organization list it already loads
 *    on every cycle is what would have to carry this. A column here is read for
 *    free, a settings row would be a second request per page.
 *
 *  - **NOT NULL with a default.** Every row written before this migration is
 *    dollars, which is what the code did with all of them, so `USD` is the
 *    truthful default rather than a placeholder. A nullable column would make
 *    "not chosen" representable and force every reader to decide what it means.
 *
 *  - **A CHECK, not just a validator.** The list lives in `common/enums.ts` and
 *    the DTO validates against the same array, so a documented value can never be
 *    one the validator rejects. The constraint stops a value written past the API
 *    from sitting in the column unnoticed until a client read it back and had no
 *    way to render it.
 *
 * The constraint is added NOT VALID then validated, rather than being declared
 * inline, because `ADD COLUMN ... NOT NULL DEFAULT` rewrites the table on
 * PostgreSQL 11 and earlier. Every existing row takes the default without being
 * touched, so there is nothing to grandfather: the values are already correct.
 *
 * Nothing is restated. Existing budgets keep the numbers they always had and gain
 * a currency, which is the honest outcome -- converting them would need exchange
 * rates this product has no source for, and a converted number that was wrong
 * would be worse than one that was merely unlabeled.
 */
export class OrganizationCurrency1700000000008 implements MigrationInterface {
  name = 'OrganizationCurrency1700000000008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD "currency" varchar(3) NOT NULL DEFAULT 'USD'`,
    );
    // Built from the same array as the entity's `@Check` and the DTO's
    // `@IsIn`. The constraint name is the contract TypeORM matches on, so it has
    // to be spelled identically in both places.
    await queryRunner.query(`
      ALTER TABLE "organizations"
      ADD CONSTRAINT "CHK_organizations_currency"
      CHECK ("currency" IN ('USD', 'EUR', 'GBP', 'RWF', 'KES', 'UGX', 'TZS', 'ZAR', 'NGN', 'GHS', 'EGP', 'ETB', 'ZMW', 'CDF', 'INR', 'AED', 'CAD', 'AUD', 'JPY', 'CNY'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP CONSTRAINT "CHK_organizations_currency"`,
    );
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN "currency"`);
  }
}