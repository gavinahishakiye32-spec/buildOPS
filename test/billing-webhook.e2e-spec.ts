import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import { jest } from '@jest/globals';
import request from 'supertest';
import Stripe from 'stripe';
import { AppModule } from '../src/app.module.js';
import { API_PREFIX, configureApp } from '../src/bootstrap.js';
import { MailService } from '../src/mail/mail.service.js';
import { BILLING_PROVIDER } from '../src/billing/billing.tokens.js';
import type {
  BillingProvider,
  PurchaseRequest,
  PurchaseResult,
} from '../src/billing/billing-provider.js';
import type { Subscription } from '../src/subscription/subscription.entity.js';
import { resetDatabase } from './support/reset-database.js';

jest.setTimeout(60000);

/**
 * Rate limiting is off by default outside development, and this suite both
 * exercises the documented 429 and needs the bucket cleared between cases. The
 * limit is lowered before `AppModule` compiles because `ThrottlerModule` reads
 * it in `forRootAsync`; 3 keeps every other case comfortably under the cap
 * while still being exhaustible by the one that is about proving it is not.
 */
const previousThrottleLimit = process.env.THROTTLE_LIMIT;
const previousThrottleTtl = process.env.THROTTLE_TTL;
const previousThrottleEnabled = process.env.THROTTLE_ENABLED;
process.env.THROTTLE_LIMIT = '3';
process.env.THROTTLE_TTL = '60000';
process.env.THROTTLE_ENABLED = 'true';

const api = (path: string): string => `/${API_PREFIX}${path}`;

const WEBHOOK_SECRET = 'whsec_webhook_e2e_secret';

/** Signs payloads exactly as Stripe does, so the real verification path runs. */
const signer = new Stripe('sk_test_webhook_e2e_signer');

const sign = (payload: string, secret = WEBHOOK_SECRET): string =>
  signer.webhooks.generateTestHeaderString({ payload, secret });

const checkoutEvent = (
  sessionId: string,
  overrides: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    id: `evt_${sessionId}`,
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        object: 'checkout_session',
        status: 'complete',
        payment_status: 'paid',
        ...overrides,
      },
    },
  });

/**
 * A provider that behaves like a real card processor: it issues a reference,
 * hands back a checkout URL and settles nothing until the signed delivery says
 * the money arrived. The bundled stub settles synchronously, which is exactly
 * why this double exists -- the route under test is the asynchronous half of
 * the seam, and the stub has no asynchronous half.
 *
 * The references are shaped like Stripe session ids so the route, the provider
 * and the subscription row are exercised the way they are in production.
 */
class SessionBillingProvider implements BillingProvider {
  readonly name = 'session-test';

  readonly settled: string[] = [];

  private readonly pending = new Map<string, string>();

  async startPurchase(request: PurchaseRequest): Promise<PurchaseResult> {
    const reference = `cs_test_${request.attemptId}`;
    this.pending.set(reference, request.plan.id);

    return {
      confirmed: false,
      reference,
      checkoutUrl: `https://checkout.stripe.test/${reference}`,
      subscriptionRef: null,
    };
  }

  async confirmPurchase(
    reference: string,
  ): Promise<{ planId: string; subscriptionRef?: string | null } | null> {
    const planId = this.pending.get(reference);

    if (!planId) {
      return null;
    }

    // Consumed on use, so a replayed delivery settles nothing twice.
    this.pending.delete(reference);
    this.settled.push(reference);

    return { planId, subscriptionRef: `sub_${reference}` };
  }

  async voidPurchase(reference: string): Promise<void> {
    this.pending.delete(reference);
  }

  async cancelSubscription(_subscription: Subscription): Promise<void> {
    // No live agreement in this double; cancellation is covered by
    // `test/billing.e2e-spec.ts`.
  }
}

describe('billing webhook (e2e)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let dataSource: DataSource;
  let billing: SessionBillingProvider;

  const mailTokens: { verify?: string } = {};

  let throttleStorage: {
    storage: Map<string, unknown>;
    hitExpirations: Map<string, unknown>;
  };

  const clearThrottle = (): void => {
    throttleStorage.storage.clear();
    throttleStorage.hitExpirations.clear();
  };

  const registerVerified = async (email: string): Promise<{ token: string }> => {
    clearThrottle();

    await request(server)
      .post(api('/auth/register'))
      .send({ email, password: 'password123', name: email })
      .expect(201);

    await request(server)
      .get(api('/auth/verify-email'))
      .query({ token: mailTokens.verify })
      .expect(200);

    const login = await request(server)
      .post(api('/auth/login'))
      .send({ email, password: 'password123' })
      .expect(201);

    return { token: login.body.access_token as string };
  };

  const planNamed = async (name: string): Promise<{ id: string }> => {
    const plans = await request(server).get(api('/plans')).expect(200);
    return plans.body.find((plan: { name: string }) => plan.name === name);
  };

  const deliver = (
    payload: string,
    options: { secret?: string; signature?: string | null } = {},
  ): request.Test => {
    const req = request(server)
      .post(api('/billing/webhook'))
      .set('Content-Type', 'application/json');

    if (options.signature === null) {
      return req.send(payload);
    }

    const signature =
      options.signature ??
      sign(payload, options.secret ?? WEBHOOK_SECRET);

    return req.set('Stripe-Signature', signature).send(payload);
  };

  beforeAll(async () => {
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    billing = new SessionBillingProvider();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MailService)
      .useValue({
        sendVerificationEmail: async (_email: string, token: string) => {
          mailTokens.verify = token;
        },
        sendResetPasswordEmail: async () => undefined,
        sendNotificationEmail: async () => undefined,
      })
      .overrideProvider(BILLING_PROVIDER)
      .useValue(billing)
      .compile();

    app = configureApp(
      // The signature covers the raw bytes of the delivery, so the app has to
      // keep them -- this is the same option `main.ts` passes in production.
      moduleFixture.createNestApplication({ rawBody: true }),
    );
    await app.init();

    server = app.getHttpServer();
    dataSource = app.get(DataSource);
    throttleStorage = app.get(ThrottlerStorage) as unknown as {
      storage: Map<string, unknown>;
      hitExpirations: Map<string, unknown>;
    };

    await resetDatabase(dataSource);
  });

  afterAll(async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;

    process.env.THROTTLE_LIMIT = previousThrottleLimit;
    process.env.THROTTLE_TTL = previousThrottleTtl;
    process.env.THROTTLE_ENABLED = previousThrottleEnabled;

    await app.close();
  });

  beforeEach(() => {
    clearThrottle();
  });

  it('applies the plan the signed delivery was paid for', async () => {
    const starter = await planNamed('Starter');
    const { token } = await registerVerified('webhook-owner@example.com');

    const pending = await request(server)
      .post(api('/subscription'))
      .set('Authorization', `Bearer ${token}`)
      .send({ planId: starter.id })
      .expect(202);

    const reference = pending.body.purchase.checkoutUrl.split('/').pop() as string;

    const response = await deliver(checkoutEvent(reference)).expect(200);
    expect(response.body).toEqual({ received: true });
    expect(billing.settled).toContain(reference);

    const current = await request(server)
      .get(api('/subscription'))
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(current.body.subscription.planId).toBe(starter.id);
    expect(current.body.subscription.status).toBe('active');
    expect(current.body.subscription.pendingPlan).toBeNull();
    // The agreement the payment created is stored, so a later cancellation can
    // stop the recurring charge instead of only the local row.
    expect(current.body.subscription.billingSubscriptionRef).toBe(
      `sub_${reference}`,
    );
  });

  it('settles a replayed delivery without applying the plan twice', async () => {
    const starter = await planNamed('Starter');
    const { token } = await registerVerified('webhook-replay@example.com');

    const pending = await request(server)
      .post(api('/subscription'))
      .set('Authorization', `Bearer ${token}`)
      .send({ planId: starter.id })
      .expect(202);
    const reference = pending.body.purchase.checkoutUrl.split('/').pop() as string;
    const payload = checkoutEvent(reference);
    const settledBefore = billing.settled.length;

    await deliver(payload).expect(200);

    // Stripe redelivers when a response is slow; the second one must be an
    // acknowledged no-op rather than a second application of the plan.
    const replayed = await deliver(payload).expect(200);
    expect(replayed.body).toEqual({ received: true });

    const current = await request(server)
      .get(api('/subscription'))
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(current.body.subscription.planId).toBe(starter.id);
    // Settled exactly once across both deliveries: the second resolved to
    // nothing because the first had already consumed the reference.
    expect(billing.settled.length).toBe(settledBefore + 1);
    expect(billing.settled.at(-1)).toBe(reference);
  });

  it('acknowledges a signed delivery for a session it never opened', async () => {
    const response = await deliver(checkoutEvent('cs_test_stranger')).expect(
      200,
    );
    expect(response.body).toEqual({ received: true });
  });

  it('acknowledges a signed event type it does not act on', async () => {
    const payload = JSON.stringify({
      id: 'evt_invoice_paid',
      object: 'event',
      type: 'invoice.paid',
      data: { object: { id: 'in_1', object: 'invoice' } },
    });

    const response = await deliver(payload).expect(200);
    expect(response.body).toEqual({ received: true });
  });

  it('rejects a delivery that carries no signature', async () => {
    const response = await deliver(checkoutEvent('cs_test_x'), {
      signature: null,
    }).expect(400);

    expect(response.body).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Missing or malformed Stripe-Signature header.',
    });
  });

  it('rejects a delivery signed with a different secret', async () => {
    const response = await deliver(checkoutEvent('cs_test_x'), {
      secret: 'whsec_not_the_configured_one',
    }).expect(400);

    expect(response.body).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Webhook signature verification failed.',
    });
  });

  it('rejects a body that does not match its signature', async () => {
    const signed = sign(checkoutEvent('cs_test_one'));
    const tampered = checkoutEvent('cs_test_two');

    const response = await deliver(tampered, { signature: signed }).expect(400);
    expect(response.body.message).toBe('Webhook signature verification failed.');
  });

  it('rejects a delivery when no signing secret is configured', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;

    try {
      const response = await deliver(checkoutEvent('cs_test_x')).expect(400);
      expect(response.body.message).toMatch(/STRIPE_WEBHOOK_SECRET/);
    } finally {
      process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    }
  });

  it('needs no bearer token: the signature is the credential', async () => {
    const response = await deliver(checkoutEvent('cs_test_anonymous')).expect(
      200,
    );
    expect(response.body).toEqual({ received: true });
  });

  it('answers 429 under the documented rate limit', async () => {
    // The suite runs with throttling on its default bucket; exhausting it here
    // proves the documented 429 on a route no browser will ever call, which is
    // the one a client generator would otherwise treat as exempt.
    clearThrottle();

    let limited: request.Response | null = null;

    for (let attempt = 0; attempt < 8; attempt++) {
      const response = await deliver(checkoutEvent('cs_test_burst'), {
        signature: null,
      });

      if (response.status === 429) {
        limited = response;
        break;
      }
    }

    expect(limited).not.toBeNull();
    expect(limited!.body).toEqual({
      statusCode: 429,
      message: 'ThrottlerException: Too Many Requests',
    });
  });
});
