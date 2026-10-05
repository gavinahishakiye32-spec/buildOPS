import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isProduction } from '../common/env.js';
import { BILLING_PROVIDER } from './billing.tokens.js';
import { StubBillingProvider } from './stub-billing.provider.js';

/**
 * Binds the payment seam.
 *
 * The provider is chosen here and nowhere else, so adding Stripe is a new
 * binding plus a new provider class rather than a change to any service.
 *
 * Until a real provider exists, the stub is mounted -- and the guard below makes
 * that safe rather than merely convenient. The stub grants paid plans for free,
 * so running it against a production database would hand every customer a
 * Business plan. It refuses to start there, and it refuses to be selected
 * explicitly through configuration, so the failure is a boot error naming the
 * missing setting instead of a silently free product.
 */
@Module({
  providers: [
    StubBillingProvider,
    {
      provide: BILLING_PROVIDER,
      inject: [ConfigService, StubBillingProvider],
      useFactory: (config: ConfigService, stub: StubBillingProvider) => {
        const selected = config.get<string>('BILLING_PROVIDER', 'stub');

        if (selected !== 'stub') {
          throw new Error(
            `BILLING_PROVIDER is "${selected}", which no registered provider answers to. Only "stub" is implemented; add the provider and its binding before selecting it.`,
          );
        }

        if (isProduction(config)) {
          throw new Error(
            'Refusing to start with BILLING_PROVIDER=stub in production: it takes no payment, so every customer would be granted the plan they selected for free. Implement a real provider and select it explicitly.',
          );
        }

        return stub;
      },
    },
  ],
  exports: [BILLING_PROVIDER],
})
export class BillingModule {}
