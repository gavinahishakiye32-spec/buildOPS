import { Module } from '@nestjs/common';
import { BillingModule } from './billing.module.js';
import { BillingWebhookController } from './billing-webhook.controller.js';
import { SubscriptionModule } from '../subscription/subscription.module.js';

/**
 * Mounts the webhook route the payment provider calls back on.
 *
 * It is its own module rather than a controller on `BillingModule` because the
 * two would otherwise import each other: `SubscriptionModule` already depends on
 * `BillingModule` for the provider token, and the webhook needs
 * `SubscriptionService` to apply a settlement. Keeping the route here leaves the
 * dependency one-directional -- billing knows nothing about subscriptions,
 * subscriptions know about billing, and the webhook wires them together.
 */
@Module({
  imports: [BillingModule, SubscriptionModule],
  controllers: [BillingWebhookController],
})
export class BillingWebhookModule {}
