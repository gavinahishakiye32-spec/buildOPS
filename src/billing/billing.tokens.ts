/**
 * Injection token for the payment provider.
 *
 * A class token would tie every consumer to the stub, which is the one provider
 * that must never reach production. Injecting through this token keeps the
 * choice in `BillingModule` alone.
 */
export const BILLING_PROVIDER = Symbol('BILLING_PROVIDER');

/**
 * The configured Stripe client.
 *
 * Shared by the provider (checkout, price lookup, cancellation) and by the
 * webhook verifier (signature checks), so both see the same account and the
 * same API version. Verification is deliberately not a second client: a
 * mismatch there would mean the route that confirms payment and the route that
 * takes it could disagree about which Stripe account they belong to.
 */
export const STRIPE_CLIENT = Symbol('STRIPE_CLIENT');
