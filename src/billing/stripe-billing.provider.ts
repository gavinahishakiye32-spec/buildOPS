import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import type Stripe from 'stripe';
import { ConfigService } from '@nestjs/config';
import { Plan } from '../plan/plan.entity.js';
import type { Subscription } from '../subscription/subscription.entity.js';
import { STRIPE_CLIENT } from './billing.tokens.js';
import type {
  BillingProvider,
  PurchaseRequest,
  PurchaseResult,
} from './billing-provider.js';

/**
 * Stripe checkout session ids all begin with this, which is what lets the
 * provider reject a reference it never issued before spending a request on it.
 */
const SESSION_PREFIX = 'cs_';

/**
 * Agreement handles all begin with this, for the same reason on the cancel path.
 */
const AGREEMENT_PREFIX = 'sub_';

/**
 * References issued for a zero-value plan: settled synchronously, so no session
 * exists to be looked up later. Kept in its own namespace so a forged
 * confirmation can never be read as one.
 */
const FREE_PURCHASE_PREFIX = 'stripe_free_';

/** Reference for a purchase that settled without a checkout session. */
export function stripeFreePurchaseReference(
  planId: string,
  attemptId: string,
): string {
  return `${FREE_PURCHASE_PREFIX}${attemptId}_${planId}`;
}

interface StripeLikeError {
  code?: string;
  type?: string;
  message?: string;
}

/**
 * Whether Stripe is reporting that the object simply is not there.
 *
 * Every call in this provider treats that as "nothing to do" rather than as a
 * failure: cancellations are retried by the caller, and a webhook is delivered
 * more than once, so "already gone" has to be the same outcome as "gone now".
 */
function isResourceMissing(error: unknown): boolean {
  return (error as StripeLikeError | null)?.code === 'resource_missing';
}

/**
 * Plans are priced in whole currency units (`19.00`); Stripe prices are in the
 * smallest unit (`1900` for USD). Rounding, not truncating, so a plan priced at
 * `19.999` cannot quietly become 19.99 at the till.
 */
function toMinorUnits(price: string): number {
  const amount = Number(price);

  if (!Number.isFinite(amount)) {
    throw new Error(
      `Plan price "${price}" is not a number, so no Stripe price can be derived from it.`,
    );
  }

  return Math.round(amount * 100);
}

/**
 * The real payment provider: a Stripe Checkout session per purchase, settled by
 * a verified webhook.
 *
 * The seam it implements (`BillingProvider`) is deliberately narrow, and the
 * provider owns everything money-shaped behind it:
 *
 * - **The amount is never taken from the caller.** Checkout is built from
 *   `plan.billingPriceRef`, a Stripe price id. The price is provisioned from
 *   the plan row on first purchase (see {@link ensurePrice}), so a client that
 *   POSTs its own price cannot buy a Business plan for a cent.
 * - **Nothing is granted synchronously.** `startPurchase` always answers with a
 *   checkout URL; only `confirmPurchase` -- reached from `POST /billing/webhook`
 *   after Stripe has signed off on the payment -- reports the money as arrived.
 * - **The previous agreement is cancelled when the new one starts billing**, so
 *   an upgrade cannot leave a customer paying for two plans. The handle of the
 *   outgoing agreement travels in the session metadata, which means the rule is
 *   enforced by the provider and the domain never has to know that Stripe
 *   exists.
 *
 * A zero-value plan is the one thing that settles synchronously, because there
 * is no money to wait for; see {@link startPurchase}.
 */
@Injectable()
export class StripeBillingProvider implements BillingProvider {
  readonly name = 'stripe';

  private readonly logger = new Logger(StripeBillingProvider.name);

  constructor(
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe,
    @InjectRepository(Plan) private readonly planRepo: Repository<Plan>,
    private readonly config: ConfigService,
  ) {}

  /**
   * Starts a Stripe Checkout session for `plan`.
   *
   * The subscription row is left untouched here (the caller applies the plan),
   * and the session carries the plan id and the outgoing agreement handle in
   * its metadata so {@link confirmPurchase} can settle the purchase from
   * Stripe's own copy of the event rather than from anything the webhook body
   * claims.
   */
  async startPurchase(request: PurchaseRequest): Promise<PurchaseResult> {
    if (toMinorUnits(request.plan.price) === 0) {
      // Nothing to collect, so the plan is in force immediately -- but the
      // agreement it replaces has to stop now, not when a webhook that will
      // never arrive would have arrived.
      await this.cancelAgreement(
        request.subscription.billingSubscriptionRef,
        'replaced by a zero-value plan',
      );

      return {
        confirmed: true,
        reference: stripeFreePurchaseReference(request.plan.id, request.attemptId),
        checkoutUrl: null,
        subscriptionRef: null,
      };
    }

    const price = await this.ensurePrice(request.plan);

    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        line_items: [{ price, quantity: 1 }],
        success_url: request.successUrl,
        cancel_url: request.cancelUrl,
        client_reference_id: request.subscription.id,
        metadata: {
          planId: request.plan.id,
          subscriptionId: request.subscription.id,
          attemptId: request.attemptId,
          // Empty string rather than an absent key: a customer on their first
          // purchase has no outgoing agreement, and metadata values are
          // required to be strings.
          previousBillingRef: request.subscription.billingSubscriptionRef ?? '',
        },
        subscription_data: {
          metadata: {
            planId: request.plan.id,
            subscriptionId: request.subscription.id,
          },
        },
      },
      // One purchase attempt, one session: a retried request after a timeout
      // must not open a second checkout the customer could pay twice on.
      { idempotencyKey: `checkout_${request.attemptId}` },
    );

    if (!session.url) {
      throw new Error(
        `Stripe returned checkout session ${session.id} without a URL; the customer has nothing to visit.`,
      );
    }

    return {
      confirmed: false,
      reference: session.id,
      checkoutUrl: session.url,
      // The subscription does not exist until the payment settles, so there is
      // no handle to report yet. `confirmPurchase` reports it.
      subscriptionRef: null,
    };
  }

  /**
   * Reads the checkout session back from Stripe and, when it is complete and
   * paid, reports the plan it was bought for.
   *
   * Every decision here is Stripe's: the plan id comes from the metadata this
   * provider wrote when it opened the session, and the payment state from the
   * session itself. A session that is still open (abandoned checkout) or
   * complete-but-unpaid (an async bank transfer that has not landed) reports
   * null, so the caller leaves the plan alone; the async case is settled by the
   * later `checkout.session.async_payment_succeeded` delivery, when Stripe says
   * the money actually arrived.
   */
  async confirmPurchase(
    reference: string,
  ): Promise<{ planId: string; subscriptionRef?: string | null } | null> {
    if (!reference.startsWith(SESSION_PREFIX)) {
      return null;
    }

    const session = await this.retrieveSession(reference);
    if (!session) {
      return null;
    }

    if (session.status !== 'complete' || session.payment_status !== 'paid') {
      this.logger.log(
        `Checkout session ${reference} is ${session.status}/${session.payment_status}; the plan stays as it is.`,
      );
      return null;
    }

    const planId = session.metadata?.planId;
    if (!planId) {
      this.logger.warn(
        `Checkout session ${reference} carries no planId metadata; ignoring a payment this application did not start.`,
      );
      return null;
    }

    const subscriptionRef =
      (typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription?.id) ?? null;

    // The new agreement is live, so the one it replaces has to stop being
    // billed. Only now: until this point the customer was still on the old
    // plan, and a webhook that arrives without payment must not cancel it.
    const previous = session.metadata?.previousBillingRef;
    if (previous && previous !== subscriptionRef) {
      await this.cancelAgreement(previous, 'replaced by a paid purchase');
    }

    return { planId, subscriptionRef };
  }

  /**
   * Expires a checkout session that was abandoned, so a customer who cancelled
   * locally cannot come back to the tab and pay for the plan they gave up.
   *
   * A session Stripe no longer considers open (already expired, already paid)
   * is not a failure -- there is nothing left to close -- but anything else is,
   * and is rethrown: reporting a successful void that did not happen is how a
   * cancelled subscription keeps charging.
   */
  async voidPurchase(reference: string): Promise<void> {
    if (!reference.startsWith(SESSION_PREFIX)) {
      return;
    }

    try {
      await this.stripe.checkout.sessions.expire(reference);
    } catch (error) {
      const session = await this.retrieveSession(reference);

      if (!session || session.status !== 'open') {
        this.logger.log(
          `Checkout session ${reference} is already ${session?.status ?? 'gone'}; nothing to void.`,
        );
        return;
      }

      throw error;
    }
  }

  /** Cancels the recurring agreement behind a subscription. */
  async cancelSubscription(subscription: Subscription): Promise<void> {
    await this.cancelAgreement(
      subscription.billingSubscriptionRef,
      'subscription cancelled by the customer',
    );
  }

  /**
   * Cancels a Stripe subscription, treating "already cancelled" and "never
   * existed" as the same outcome so retries and duplicated webhooks stay safe.
   *
   * A handle that is not a Stripe subscription id is logged rather than sent:
   * it means the column was written by a different provider or by hand, and
   * asking Stripe to cancel it would fail with a confusing 400.
   */
  private async cancelAgreement(
    reference: string | null,
    reason: string,
  ): Promise<void> {
    if (!reference) {
      return;
    }

    if (!reference.startsWith(AGREEMENT_PREFIX)) {
      this.logger.warn(
        `Not cancelling "${reference}": it is not a Stripe subscription id.`,
      );
      return;
    }

    try {
      await this.stripe.subscriptions.cancel(reference);
      this.logger.log(`Cancelled Stripe subscription ${reference} (${reason}).`);
    } catch (error) {
      if (isResourceMissing(error)) {
        this.logger.log(
          `Stripe subscription ${reference} is already gone; nothing to cancel (${reason}).`,
        );
        return;
      }

      throw error;
    }
  }

  /** The session, or null when Stripe does not know the reference at all. */
  private async retrieveSession(
    reference: string,
  ): Promise<Stripe.Checkout.Session | null> {
    try {
      return await this.stripe.checkout.sessions.retrieve(reference);
    } catch (error) {
      if (isResourceMissing(error)) {
        return null;
      }

      throw error;
    }
  }

  /**
   * Resolves the Stripe price to charge for `plan`, provisioning it if the plan
   * has never been sold before.
   *
   * This is what keeps `plans.billing_price_ref` honest: the column starts null
   * (nothing has been sold, or the seed created the catalogue before Stripe was
   * configured) and is written only by this method, from Stripe's own response.
   * An existing reference is verified against the plan rather than trusted --
   * repricing a plan has to move the price too, or the catalogue and the till
   * disagree silently.
   *
   * A reference that Stripe reports as missing falls through to provisioning,
   * so deleting the price in the Stripe dashboard cannot wedge purchases.
   */
  private async ensurePrice(plan: Plan): Promise<string> {
    const amount = toMinorUnits(plan.price);
    const currency = this.currency();

    if (plan.billingPriceRef) {
      try {
        const existing = await this.stripe.prices.retrieve(
          plan.billingPriceRef,
        );

        if (
          existing.active &&
          existing.unit_amount === amount &&
          existing.currency === currency
        ) {
          return existing.id;
        }

        // Reprice under the product this plan already owns, rather than
        // creating a second product that would fragment its history.
        const product =
          typeof existing.product === 'string'
            ? existing.product
            : existing.product.id;

        return await this.createPrice(plan, product, amount, currency);
      } catch (error) {
        if (!isResourceMissing(error)) {
          throw error;
        }
      }
    }

    const product = await this.stripe.products.create({
      name: plan.name,
      ...(plan.description ? { description: plan.description } : {}),
      metadata: { planId: plan.id },
    });

    return await this.createPrice(plan, product.id, amount, currency);
  }

  /**
   * Creates the recurring price and records it on the plan row in the same
   * breath: a price that exists in Stripe but not in the catalogue would be
   * looked up again on the next purchase, minting a duplicate.
   */
  private async createPrice(
    plan: Plan,
    productId: string,
    amount: number,
    currency: string,
  ): Promise<string> {
    const price = await this.stripe.prices.create({
      product: productId,
      unit_amount: amount,
      currency,
      recurring: { interval: 'month' },
      nickname: plan.name,
    });

    await this.planRepo.update(plan.id, { billingPriceRef: price.id });
    plan.billingPriceRef = price.id;

    this.logger.log(
      `Provisioned Stripe price ${price.id} for plan ${plan.name} (${amount} ${currency}).`,
    );

    return price.id;
  }

  private currency(): string {
    return (this.config.get<string>('STRIPE_CURRENCY') ?? 'usd')
      .trim()
      .toLowerCase();
  }
}
