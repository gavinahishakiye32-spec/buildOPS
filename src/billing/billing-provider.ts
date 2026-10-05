import type { Plan } from '../plan/plan.entity.js';
import type { Subscription } from '../subscription/subscription.entity.js';

/**
 * What the caller must know to start a purchase.
 *
 * Only the fields a payment provider actually needs are passed. Notably absent:
 * the price. The provider owns the amount and looks it up from its own catalogue
 * by `plan.billingPriceRef`. Trusting a price sent by the client is how a
 * customer talks their way into a Business plan for one cent.
 */
export interface PurchaseRequest {
  subscription: Subscription;
  plan: Plan;
  /**
   * Opaque per-attempt id the caller generated, for the provider's logs and its
   * own idempotency key.
   *
   * This is NOT the reference the payment comes back against. That belongs to
   * the provider, which is why `PurchaseResult` returns one: a card session id,
   * a session id, an invoice number. The application stores it and hands it
   * straight back to `confirmPurchase`, so the provider stays the only component
   * that can interpret it.
   */
  attemptId: string;
  /** Absolute URL the provider redirects to once payment settles. */
  successUrl: string;
  cancelUrl: string;
}

/**
 * The outcome of asking a provider to take money for a plan.
 *
 * `confirmed: true` means the money is already settled and the plan may be
 * applied immediately. `confirmed: false` means the customer has to visit
 * `checkoutUrl` first, and the plan must NOT change until the provider confirms
 * payment out of band. Both cases are real: a zero-value plan or an internal
 * invoice settles instantly, a card payment does not.
 */
export interface PurchaseResult {
  confirmed: boolean;
  /**
   * The handle payment will be reported against, and which
   * `confirmPurchase` accepts. Unique per attempt -- see
   * `PurchaseRequest.attemptId` for why the provider owns it.
   */
  reference: string;
  /** Where to send the customer to pay. Null when `confirmed` is true. */
  checkoutUrl: string | null;
  /** Provider-side handle for the resulting recurring subscription, if any. */
  subscriptionRef: string | null;
}

/**
 * The payment seam.
 *
 * Everything about how money is collected lives behind this interface, so the
 * subscription rules -- capacity, downgrade safety, trial expiry -- stay
 * provider-independent and testable without a network or an account. The
 * application is the only caller; the provider is the only thing that knows
 * about Stripe, Paddle, an invoice, or the stub used in development.
 *
 * An implementation must be idempotent for a given `reference`: a webhook
 * delivery is retried, and applying a plan twice would let a customer change
 * plans around the downgrade guard.
 */
export interface BillingProvider {
  /** Identifies the provider in logs and in the `pendingPlanReference` audit. */
  readonly name: string;

  /**
   * Requests payment for `plan`. Must not change the subscription's plan: the
   * caller applies it, either now (when `confirmed`) or from the webhook.
   */
  startPurchase(request: PurchaseRequest): Promise<PurchaseResult>;

  /**
   * Reports that the money for `reference` arrived. Returns the plan id that
   * was paid for, or null when the reference is unknown to this provider.
   *
   * The provider resolves the reference from its own records, so a webhook can be
   * processed without trusting anything in the request body.
   */
  confirmPurchase(reference: string): Promise<{ planId: string } | null>;

  /**
   * Abandons a purchase that has not settled, so a late payment cannot complete
   * it. Idempotent.
   *
   * This is separate from `cancelSubscription` because the two cover different
   * states: a customer walking away from a checkout has no agreement to cancel
   * but still has a live payment session, and leaving that session open means
   * they can be charged for a plan they explicitly gave up.
   */
  voidPurchase(reference: string): Promise<void>;

  /** Stops future billing against the subscription. Idempotent. */
  cancelSubscription(subscription: Subscription): Promise<void>;
}
