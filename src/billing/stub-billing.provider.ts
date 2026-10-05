import { Injectable, Logger } from '@nestjs/common';
import type {
  BillingProvider,
  PurchaseRequest,
  PurchaseResult,
} from './billing-provider.js';
import type { Subscription } from '../subscription/subscription.entity.js';

/**
 * Purchase references and agreement handles are kept in separate namespaces so
 * a handle can never be mistaken for a purchase attempt: `confirmPurchase` is
 * handed whatever arrives on the webhook, and the only thing it may trust is a
 * reference it recognises as a purchase.
 */
export const PURCHASE_PREFIX = 'stub_purchase_';
const AGREEMENT_PREFIX = 'stub_agreement_';

/**
 * Builds the reference the stub recognises for one purchase attempt.
 *
 * The attempt id makes the reference unique. Deriving it from the plan alone
 * gave every customer buying the same plan the same reference, and
 * `SubscriptionService.confirmPurchase` looks the subscription up *by reference*,
 * so a confirmation could resolve to an arbitrary one of them.
 */
export function stubPurchaseReference(
  planId: string,
  attemptId: string,
): string {
  return `${PURCHASE_PREFIX}${attemptId}_${planId}`;
}

/**
 * Extracts the plan id from a stub purchase reference.
 *
 * Plan ids are UUIDs, so the last underscore unambiguously separates the attempt
 * id from the plan.
 */
export function stubPlanIdFromReference(reference: string): string | null {
  if (!reference.startsWith(PURCHASE_PREFIX)) {
    return null;
  }

  const body = reference.slice(PURCHASE_PREFIX.length);
  const separator = body.lastIndexOf('_');

  return separator === -1 ? null : body.slice(separator + 1);
}

/**
 * The development and test payment provider: it settles every purchase
 * instantly and charges nothing.
 *
 * It exists so the subscription rules -- the downgrade guard, capacity, trial
 * expiry -- can be built and tested end to end before a payment account exists,
 * and so nothing in the domain has to know whether money was taken. Swapping in
 * Stripe is a provider binding in `BillingModule`, not a change to any service.
 *
 * The risk this carries is deliberate and loud: with this provider mounted,
 * `PATCH /subscription/plan` grants the paid plan for free. It therefore refuses
 * to run in production, and `BillingModule` throws at boot rather than falling
 * back to it.
 */
@Injectable()
export class StubBillingProvider implements BillingProvider {
  readonly name = 'stub';

  private readonly logger = new Logger(StubBillingProvider.name);

  async startPurchase(request: PurchaseRequest): Promise<PurchaseResult> {
    this.logger.log(
      `Stub payment: granting plan ${request.plan.name} (${request.plan.price}) to subscription ${request.subscription.id} with no charge taken`,
    );

    return {
      confirmed: true,
      // Issued even though nothing is ever pending under this provider, so the
      // audit column is populated the same way a real provider would populate
      // it and the flow does not have a special case for the stub.
      reference: stubPurchaseReference(request.plan.id, request.attemptId),
      checkoutUrl: null,
      subscriptionRef: `${AGREEMENT_PREFIX}${request.subscription.id}`,
    };
  }

  async confirmPurchase(reference: string): Promise<{ planId: string } | null> {
    // Nothing can ever be pending under this provider: `startPurchase` always
    // settles, so a confirmation is always either a duplicate delivery or a
    // forged call. Returning null makes the caller refuse it, which is the
    // correct outcome -- a client must not be able to claim a paid plan it
    // never bought by posting a made-up reference.
    this.logger.warn(
      `Ignored a payment confirmation for "${reference}": this provider settles purchases synchronously`,
    );
    return null;
  }

  async voidPurchase(reference: string): Promise<void> {
    this.logger.log(
      `Ignoring a request to void "${reference}": this provider settles purchases synchronously, so there is nothing outstanding`,
    );
  }

  async cancelSubscription(subscription: Subscription): Promise<void> {
    this.logger.log(
      `Stub cancellation: no real agreement to cancel for subscription ${subscription.id}`,
    );
  }
}
