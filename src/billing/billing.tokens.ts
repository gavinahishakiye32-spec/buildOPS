/**
 * Injection token for the payment provider.
 *
 * A class token would tie every consumer to the stub, which is the one provider
 * that must never reach production. Injecting through this token keeps the
 * choice in `BillingModule` alone.
 */
export const BILLING_PROVIDER = Symbol('BILLING_PROVIDER');
