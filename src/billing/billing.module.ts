import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import Stripe from 'stripe';
import { Plan } from '../plan/plan.entity.js';
import { isProduction } from '../common/env.js';
import { BILLING_PROVIDER, STRIPE_CLIENT } from './billing.tokens.js';
import { StubBillingProvider } from './stub-billing.provider.js';
import { StripeBillingProvider } from './stripe-billing.provider.js';
import { StripeWebhookVerifier } from './stripe-webhook.verifier.js';

/**
 * A key that lets the client be constructed when Stripe is not the selected
 * provider (or is not configured yet), because the webhook verifier only ever
 * uses it for local signature checks and never for a request.
 *
 * The moment a purchase is attempted under `BILLING_PROVIDER=stripe`, the
 * selection guard below has already insisted on a real `STRIPE_SECRET_KEY`, so
 * this value is never sent to Stripe's API.
 */
const UNCONFIGURED_KEY = 'sk_test_not_configured';

/**
 * Binds the payment seam.
 *
 * The provider is chosen here and nowhere else, and the choice is explicit
 * rather than defaulted, because the two options fail in opposite directions:
 * `stub` grants every paid plan for free, and `stripe` needs credentials that a
 * fresh clone does not have. So `stripe` must ask for its keys by name, and
 * production must name `stripe` by name; anything else -- an unset variable, a
 * typo, or the stub pointed at real data -- is a boot error rather than a
 * silently wrong product.
 *
 * The webhook signing secret is required alongside the key: a deployment that
 * takes payments but cannot verify their confirmation would leave customers
 * paying for plans that never activate, which is worse than not booting.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Plan])],
  providers: [
    StubBillingProvider,
    StripeBillingProvider,
    StripeWebhookVerifier,
    {
      provide: STRIPE_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Stripe(
          config.get<string>('STRIPE_SECRET_KEY')?.trim() || UNCONFIGURED_KEY,
          {
            typescript: true,
            // Retries are what stop a single flaky connection from failing a
            // purchase or a webhook the caller will retry anyway.
            maxNetworkRetries: 2,
          },
        ),
    },
    {
      provide: BILLING_PROVIDER,
      inject: [ConfigService, StubBillingProvider, StripeBillingProvider],
      useFactory: (
        config: ConfigService,
        stub: StubBillingProvider,
        stripe: StripeBillingProvider,
      ) => {
        const configured = config.get<string>('BILLING_PROVIDER')?.trim();
        const selected = configured || (isProduction(config) ? '' : 'stub');

        if (!selected) {
          throw new Error(
            'BILLING_PROVIDER is not set. The default would be the "stub" provider, which takes no payment and grants every paid plan for free, so it refuses to start in production: set BILLING_PROVIDER=stripe and configure STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.',
          );
        }

        if (selected === 'stub') {
          if (isProduction(config)) {
            throw new Error(
              'Refusing to start with BILLING_PROVIDER=stub in production: it takes no payment, so every customer would be granted the plan they selected for free. Set BILLING_PROVIDER=stripe and configure STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.',
            );
          }

          return stub;
        }

        if (selected !== 'stripe') {
          throw new Error(
            `BILLING_PROVIDER is "${selected}", which no registered provider answers to. Implemented providers: "stripe" (real payments) and "stub" (development only).`,
          );
        }

        if (!config.get<string>('STRIPE_SECRET_KEY')?.trim()) {
          throw new Error(
            'BILLING_PROVIDER is "stripe" but STRIPE_SECRET_KEY is not set. Copy it from the Stripe dashboard (Developers > API keys), or select BILLING_PROVIDER=stub to develop without payments.',
          );
        }

        if (!config.get<string>('STRIPE_WEBHOOK_SECRET')?.trim()) {
          throw new Error(
            'BILLING_PROVIDER is "stripe" but STRIPE_WEBHOOK_SECRET is not set. Create a webhook endpoint pointing at POST /api/v1/billing/webhook and copy its signing secret: without it, checkout payments can be taken but never confirmed, and no plan would activate.',
          );
        }

        return stripe;
      },
    },
  ],
  exports: [BILLING_PROVIDER, STRIPE_CLIENT, StripeWebhookVerifier],
})
export class BillingModule {}
