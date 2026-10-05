import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Billing state and expiring trials.
 *
 * Adds the three things the subscription lifecycle was missing:
 *
 *  - `trial_ends_at`, so "trial" stops being an open-ended free tier. Capacity
 *    checks read it (`isUsableSubscription`), and a lapsed trial refuses new
 *    organizations, members and projects without any scheduled job having to
 *    rewrite the row.
 *  - `pending_plan_id` / `pending_plan_reference`, so a plan change is applied
 *    when payment settles rather than when it is requested. Before this, a
 *    signed-in customer could move themselves to Business by calling
 *    `PATCH /subscription/plan`; the plan was written to `plan_id` immediately
 *    and nothing ever confirmed that money changed hands.
 *  - `billing_subscription_ref`, the provider-side handle for the recurring
 *    agreement, so cancellation and reconciliation address the provider rather
 *    than our own tables.
 *
 * `plans.billing_price_ref` is the provider's own identifier for the plan's
 * price. Purchases carry it rather than the `price` column, so the amount is
 * never taken from a request body.
 *
 * Every column is nullable and added without a default, so this is a
 * non-blocking rewrite on an existing table: existing subscriptions keep their
 * `trial` status with a null `trial_ends_at`, which the predicates read as
 * "never expires" rather than "expired now". Backfill deliberately does not set
 * an end date -- see the note in the README on trialling existing customers.
 */
export class BillingAndTrialExpiry1700000000001
  implements MigrationInterface
{
  name = 'BillingAndTrialExpiry1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tenants" ADD "trial_ends_at" TIMESTAMP`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenants" ADD "pending_plan_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenants" ADD "pending_plan_reference" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenants" ADD "billing_subscription_ref" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "plans" ADD "billing_price_ref" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tenants" DROP COLUMN "billing_subscription_ref"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenants" DROP COLUMN "pending_plan_reference"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenants" DROP COLUMN "pending_plan_id"`,
    );
    await queryRunner.query(`ALTER TABLE "tenants" DROP COLUMN "trial_ends_at"`);
    await queryRunner.query(
      `ALTER TABLE "plans" DROP COLUMN "billing_price_ref"`,
    );
  }
}
