import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type Stripe from 'stripe';
import type { Repository } from 'typeorm';
import {
  StripeBillingProvider,
  stripeFreePurchaseReference,
} from './stripe-billing.provider.js';
import type { Plan } from '../plan/plan.entity.js';
import type { Subscription } from '../subscription/subscription.entity.js';
import type { PurchaseRequest } from './billing-provider.js';

/**
 * Stripe failures are matched structurally rather than by class: the provider
 * only ever inspects `code`, and building the real error class here would
 * couple this file to stripe-node's internals for no gain.
 */
const stripeError = (code: string, message = 'Stripe error'): Error =>
  Object.assign(new Error(message), { code, type: 'StripeInvalidRequestError' });

const resourceMissing = (message = 'No such resource'): Error =>
  stripeError('resource_missing', message);

const outage = (): Error => Object.assign(new Error('upstream 500'), { code: 'api_error' });

const plan = (overrides: Partial<Plan> = {}): Plan =>
  ({
    id: 'plan-1',
    name: 'Starter',
    description: 'Single workspace.',
    maxUsers: 5,
    maxProjects: 3,
    maxStorageGb: 5,
    maxOrganizations: 1,
    price: '19.00',
    billingPriceRef: 'price_abc',
    createdAt: new Date(),
    updatedAt: new Date(),
    toResponse: () => ({}),
    ...overrides,
  }) as Plan;

const subscription = (overrides: Partial<Subscription> = {}): Subscription =>
  ({
    id: 'subscription-1',
    userId: 'user-1',
    planId: 'plan-0',
    status: 'active',
    billingSubscriptionRef: null,
    pendingPlanId: null,
    pendingPlanReference: null,
    trialEndsAt: null,
    ...overrides,
  }) as Subscription;

const request = (
  overrides: Partial<PurchaseRequest> = {},
): PurchaseRequest => ({
  subscription: subscription(),
  plan: plan(),
  attemptId: 'attempt-1',
  successUrl: 'https://app.test/subscription?purchase=confirmed',
  cancelUrl: 'https://app.test/subscription?purchase=cancelled',
  ...overrides,
});

describe('StripeBillingProvider', () => {
  let stripe: {
    checkout: {
      sessions: {
        create: jest.Mock<any>;
        retrieve: jest.Mock<any>;
        expire: jest.Mock<any>;
      };
    };
    prices: { retrieve: jest.Mock<any>; create: jest.Mock<any> };
    products: { create: jest.Mock<any> };
    subscriptions: { cancel: jest.Mock<any> };
  };
  let planRepo: { update: jest.Mock<any> };
  let config: { get: jest.Mock<any> };
  let provider: StripeBillingProvider;

  beforeEach(() => {
    stripe = {
      checkout: {
        sessions: {
          create: jest.fn(async () => ({
            id: 'cs_test_1',
            url: 'https://checkout.stripe.test/cs_test_1',
          })),
          retrieve: jest.fn(),
          expire: jest.fn(async () => ({ id: 'cs_test_1', status: 'expired' })),
        },
      },
      prices: { retrieve: jest.fn(), create: jest.fn() },
      products: { create: jest.fn(async () => ({ id: 'prod_1' })) },
      subscriptions: { cancel: jest.fn(async () => ({ id: 'sub_x' })) },
    };

    planRepo = { update: jest.fn(async () => ({ affected: 1 })) };
    config = {
      get: jest.fn((_key: string, fallback?: string) => fallback),
    };

    provider = new StripeBillingProvider(
      stripe as unknown as Stripe,
      planRepo as unknown as Repository<Plan>,
      config as unknown as ConfigService,
    );
  });

  describe('startPurchase', () => {
    it('opens a checkout session priced from the plan reference', async () => {
      stripe.prices.retrieve.mockResolvedValue({
        id: 'price_abc',
        active: true,
        unit_amount: 1900,
        currency: 'usd',
        product: 'prod_1',
      });

      const result = await provider.startPurchase(request());

      expect(result).toEqual({
        confirmed: false,
        reference: 'cs_test_1',
        checkoutUrl: 'https://checkout.stripe.test/cs_test_1',
        subscriptionRef: null,
      });

      const [body, options] = stripe.checkout.sessions.create.mock.calls[0] as [
        Record<string, unknown>,
        Record<string, unknown>,
      ];
      expect(body.mode).toBe('subscription');
      expect(body.line_items).toEqual([{ price: 'price_abc', quantity: 1 }]);
      expect(body.success_url).toBe(
        'https://app.test/subscription?purchase=confirmed',
      );
      expect(body.metadata).toMatchObject({
        planId: 'plan-1',
        subscriptionId: 'subscription-1',
        previousBillingRef: '',
      });
      // One attempt, one session: a retried request must not open a checkout
      // the customer could pay twice on.
      expect(options).toEqual({ idempotencyKey: 'checkout_attempt-1' });
      expect(planRepo.update).not.toHaveBeenCalled();
    });

    it('passes the outgoing agreement so it can be cancelled on settlement', async () => {
      stripe.prices.retrieve.mockResolvedValue({
        id: 'price_abc',
        active: true,
        unit_amount: 1900,
        currency: 'usd',
        product: 'prod_1',
      });

      await provider.startPurchase(
        request({
          subscription: subscription({ billingSubscriptionRef: 'sub_old' }),
        }),
      );

      const [body] = stripe.checkout.sessions.create.mock.calls[0] as [
        Record<string, unknown>,
      ];
      expect(body.metadata).toMatchObject({
        previousBillingRef: 'sub_old',
      });
    });

    it('provisions the product and price when the plan has never been sold', async () => {
      const first = plan({ billingPriceRef: null });
      stripe.prices.create.mockResolvedValue({ id: 'price_created' });

      const result = await provider.startPurchase(request({ plan: first }));

      expect(result.confirmed).toBe(false);
      expect(stripe.prices.retrieve).not.toHaveBeenCalled();
      expect(stripe.products.create).toHaveBeenCalledWith({
        name: 'Starter',
        description: 'Single workspace.',
        metadata: { planId: 'plan-1' },
      });
      expect(stripe.prices.create).toHaveBeenCalledWith({
        product: 'prod_1',
        unit_amount: 1900,
        currency: 'usd',
        recurring: { interval: 'month' },
        nickname: 'Starter',
      });
      // Written back immediately: a price that exists only in Stripe would be
      // provisioned again on the next purchase.
      expect(planRepo.update).toHaveBeenCalledWith('plan-1', {
        billingPriceRef: 'price_created',
      });
      expect(first.billingPriceRef).toBe('price_created');

      const [body] = stripe.checkout.sessions.create.mock.calls[0] as [
        Record<string, unknown>,
      ];
      expect(body.line_items).toEqual([
        { price: 'price_created', quantity: 1 },
      ]);
    });

    it('reprices under the same product when the plan price changed', async () => {
      stripe.prices.retrieve.mockResolvedValue({
        id: 'price_old',
        active: true,
        unit_amount: 500,
        currency: 'usd',
        product: 'prod_7',
      });
      stripe.prices.create.mockResolvedValue({ id: 'price_new' });

      const updated = plan({ price: '19.00', billingPriceRef: 'price_old' });
      await provider.startPurchase(request({ plan: updated }));

      expect(stripe.products.create).not.toHaveBeenCalled();
      expect(stripe.prices.create).toHaveBeenCalledWith(
        expect.objectContaining({ product: 'prod_7', unit_amount: 1900 }),
      );
      expect(planRepo.update).toHaveBeenCalledWith('plan-1', {
        billingPriceRef: 'price_new',
      });
      expect(updated.billingPriceRef).toBe('price_new');
    });

    it('provisions a replacement when the stored reference no longer exists', async () => {
      stripe.prices.retrieve.mockRejectedValue(resourceMissing());
      stripe.prices.create.mockResolvedValue({ id: 'price_replacement' });

      await provider.startPurchase(request());

      expect(stripe.products.create).toHaveBeenCalled();
      expect(stripe.prices.create).toHaveBeenCalledWith(
        expect.objectContaining({ unit_amount: 1900 }),
      );
    });

    it('settles a zero-value plan immediately and stops the agreement it replaces', async () => {
      const result = await provider.startPurchase(
        request({
          plan: plan({ price: '0.00', billingPriceRef: null }),
          subscription: subscription({ billingSubscriptionRef: 'sub_old' }),
        }),
      );

      expect(result).toEqual({
        confirmed: true,
        reference: stripeFreePurchaseReference('plan-1', 'attempt-1'),
        checkoutUrl: null,
        subscriptionRef: null,
      });
      expect(stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_old');
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
      expect(stripe.products.create).not.toHaveBeenCalled();
    });

    it('refuses to price a plan whose price is not a number', async () => {
      await expect(
        provider.startPurchase(request({ plan: plan({ price: 'cheap' }) })),
      ).rejects.toThrow(/not a number/);
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it('surfaces a session Stripe opened without a URL', async () => {
      stripe.prices.retrieve.mockResolvedValue({
        id: 'price_abc',
        active: true,
        unit_amount: 1900,
        currency: 'usd',
        product: 'prod_1',
      });
      stripe.checkout.sessions.create.mockResolvedValue({
        id: 'cs_test_1',
        url: null,
      });

      await expect(provider.startPurchase(request())).rejects.toThrow(
        /without a URL/,
      );
    });
  });

  describe('confirmPurchase', () => {
    const paidSession = (overrides: Record<string, unknown> = {}) => ({
      id: 'cs_test_1',
      status: 'complete',
      payment_status: 'paid',
      metadata: { planId: 'plan-1' },
      subscription: 'sub_new',
      ...overrides,
    });

    it('returns null for a reference this provider never issued', async () => {
      await expect(
        provider.confirmPurchase('stub_purchase_something'),
      ).resolves.toBeNull();
      expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
    });

    it('reports the plan and the new agreement once the money is in', async () => {
      stripe.checkout.sessions.retrieve.mockResolvedValue(
        paidSession({ metadata: { planId: 'plan-1', previousBillingRef: 'sub_old' } }),
      );

      await expect(provider.confirmPurchase('cs_test_1')).resolves.toEqual({
        planId: 'plan-1',
        subscriptionRef: 'sub_new',
      });
      // The plan it replaces stops billing now that this one has started.
      expect(stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_old');
    });

    it('leaves the agreement alone when there is nothing to replace', async () => {
      stripe.checkout.sessions.retrieve.mockResolvedValue(
        paidSession({ metadata: { planId: 'plan-1', previousBillingRef: '' } }),
      );

      await provider.confirmPurchase('cs_test_1');

      expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    });

    it('reports nothing while the session is still open', async () => {
      stripe.checkout.sessions.retrieve.mockResolvedValue(
        paidSession({ status: 'open', payment_status: 'unpaid' }),
      );

      await expect(provider.confirmPurchase('cs_test_1')).resolves.toBeNull();
      expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    });

    it('reports nothing for a completed but unpaid async payment', async () => {
      stripe.checkout.sessions.retrieve.mockResolvedValue(
        paidSession({ payment_status: 'unpaid' }),
      );

      await expect(provider.confirmPurchase('cs_test_1')).resolves.toBeNull();
    });

    it('returns null when Stripe does not know the session', async () => {
      stripe.checkout.sessions.retrieve.mockRejectedValue(resourceMissing());

      await expect(provider.confirmPurchase('cs_test_1')).resolves.toBeNull();
    });

    it('refuses a payment this application did not start', async () => {
      stripe.checkout.sessions.retrieve.mockResolvedValue(
        paidSession({ metadata: {} }),
      );

      await expect(provider.confirmPurchase('cs_test_1')).resolves.toBeNull();
    });

    it('propagates a Stripe outage so the delivery is retried', async () => {
      stripe.checkout.sessions.retrieve.mockRejectedValue(outage());

      await expect(provider.confirmPurchase('cs_test_1')).rejects.toThrow(
        /upstream 500/,
      );
    });
  });

  describe('voidPurchase', () => {
    it('expires a session that is still open', async () => {
      await provider.voidPurchase('cs_test_1');
      expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith('cs_test_1');
    });

    it('treats a session Stripe already closed as nothing to void', async () => {
      stripe.checkout.sessions.expire.mockRejectedValue(outage());
      stripe.checkout.sessions.retrieve.mockResolvedValue({
        status: 'complete',
      });

      await expect(provider.voidPurchase('cs_test_1')).resolves.toBeUndefined();
    });

    it('treats a session Stripe no longer knows as nothing to void', async () => {
      stripe.checkout.sessions.expire.mockRejectedValue(outage());
      stripe.checkout.sessions.retrieve.mockRejectedValue(resourceMissing());

      await expect(provider.voidPurchase('cs_test_1')).resolves.toBeUndefined();
    });

    it('rethrows when the session is still open and the void failed', async () => {
      stripe.checkout.sessions.expire.mockRejectedValue(outage());
      stripe.checkout.sessions.retrieve.mockResolvedValue({ status: 'open' });

      await expect(provider.voidPurchase('cs_test_1')).rejects.toThrow(
        /upstream 500/,
      );
    });

    it('does nothing for a reference it never issued', async () => {
      await provider.voidPurchase('stub_purchase_1');
      expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
    });
  });

  describe('cancelSubscription', () => {
    it('cancels the recurring agreement behind the subscription', async () => {
      await provider.cancelSubscription(
        subscription({ billingSubscriptionRef: 'sub_live' }),
      );
      expect(stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_live');
    });

    it('does nothing when the subscription never had an agreement', async () => {
      await provider.cancelSubscription(
        subscription({ billingSubscriptionRef: null }),
      );
      expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    });

    it('does not send another provider’s handle to Stripe', async () => {
      await provider.cancelSubscription(
        subscription({ billingSubscriptionRef: 'paddle_plan_1' }),
      );
      expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    });

    it('treats an agreement that is already cancelled as cancelled', async () => {
      stripe.subscriptions.cancel.mockRejectedValue(resourceMissing());

      await expect(
        provider.cancelSubscription(
          subscription({ billingSubscriptionRef: 'sub_live' }),
        ),
      ).resolves.toBeUndefined();
    });

    it('rethrows a cancellation that did not happen', async () => {
      stripe.subscriptions.cancel.mockRejectedValue(outage());

      await expect(
        provider.cancelSubscription(
          subscription({ billingSubscriptionRef: 'sub_live' }),
        ),
      ).rejects.toThrow(/upstream 500/);
    });
  });
});
