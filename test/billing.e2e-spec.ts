import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import { jest } from '@jest/globals';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { API_PREFIX, configureApp } from '../src/bootstrap.js';
import { MailService } from '../src/mail/mail.service.js';
import { BILLING_PROVIDER } from '../src/billing/billing.tokens.js';
import {
  PURCHASE_PREFIX,
  stubPurchaseReference,
} from '../src/billing/stub-billing.provider.js';
import type {
  BillingProvider,
  PurchaseRequest,
  PurchaseResult,
} from '../src/billing/billing-provider.js';
import type { Subscription } from '../src/subscription/subscription.entity.js';
import { SubscriptionService } from '../src/subscription/subscription.service.js';
import { resetDatabase } from './support/reset-database.js';

jest.setTimeout(60000);

const api = (path: string): string => `/${API_PREFIX}${path}`;

/**
 * The reference the provider issued for a purchase, read back out of the
 * checkout URL the customer was given. The reference is provider-owned and
 * unique per attempt, so the tests recover it the way a webhook would rather
 * than predicting it.
 */
const referenceOf = (response: request.Response): string =>
  decodeURIComponent(response.body.purchase.checkoutUrl.split('/').pop() as string);

/**
 * A provider that behaves the way a real card processor does: it hands back a
 * checkout URL and settles nothing until the customer completes it.
 *
 * The stub provider bundled with the app settles synchronously, which is what
 * keeps the ordinary suites readable. It also means the stub settles
 * *every* time, so the rule this whole feature exists for -- a plan is never put
 * in force before the money arrives -- would go untested if only the stub were
 * used. That is what this double is for.
 */
class DeferredBillingProvider implements BillingProvider {
  readonly name = 'deferred-test';

  readonly started: PurchaseRequest[] = [];
  readonly cancelled: string[] = [];
  readonly voided: string[] = [];

  /** Reference the provider will honour, mimicking a signed webhook. */
  private readonly honoured = new Map<string, string>();

  async startPurchase(payload: PurchaseRequest): Promise<PurchaseResult> {
    this.started.push(payload);

    // The reference is the provider's to issue, exactly as a real one would
    // mint a session id, and it records the plan it stands for.
    const reference = stubPurchaseReference(payload.plan.id, payload.attemptId);
    this.honoured.set(reference, payload.plan.id);

    return {
      confirmed: false,
      reference,
      checkoutUrl: `https://checkout.test/${encodeURIComponent(reference)}`,
      subscriptionRef: null,
    };
  }

  async confirmPurchase(reference: string): Promise<{ planId: string } | null> {
    const planId = this.honoured.get(reference);

    if (!planId) {
      return null;
    }

    // Consumed on use, so a replayed webhook resolves to nothing.
    this.honoured.delete(reference);
    return { planId };
  }

  async voidPurchase(reference: string): Promise<void> {
    this.voided.push(reference);
    this.honoured.delete(reference);
  }

  async cancelSubscription(subscription: Subscription): Promise<void> {
    this.cancelled.push(subscription.id);
  }
}

describe('billing gate (e2e)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let dataSource: DataSource;
  let billing: DeferredBillingProvider;
  let subscriptionService: SubscriptionService;
  let throttleStorage: {
    storage: Map<string, unknown>;
    hitExpirations: Map<string, unknown>;
  };

  const mailTokens: { verify?: string } = {};

  const clearThrottle = (): void => {
    throttleStorage.storage.clear();
    throttleStorage.hitExpirations.clear();
  };

  const registerVerified = async (
    email: string,
  ): Promise<{ token: string }> => {
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

  const asUser =
    (token: string) =>
    (req: request.Test): request.Test =>
      req.set('Authorization', `Bearer ${token}`);

  const planNamed = async (name: string): Promise<{ id: string }> => {
    const plans = await request(server).get(api('/plans')).expect(200);
    return plans.body.find((plan: { name: string }) => plan.name === name);
  };

  beforeAll(async () => {
    billing = new DeferredBillingProvider();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MailService)
      .useValue({
        sendVerificationEmail: async (_email: string, token: string) => {
          mailTokens.verify = token;
        },
        sendResetPasswordEmail: async () => undefined,
      })
      .overrideProvider(BILLING_PROVIDER)
      .useValue(billing)
      .compile();

    app = configureApp(moduleFixture.createNestApplication());
    await app.init();

    server = app.getHttpServer();
    dataSource = app.get(DataSource);
    subscriptionService = app.get(SubscriptionService);
    throttleStorage = app.get(ThrottlerStorage) as unknown as {
      storage: Map<string, unknown>;
      hitExpirations: Map<string, unknown>;
    };

    await resetDatabase(dataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses to boot in production while the stub provider is selected', async () => {
    // The guard is the only thing standing between a misconfiguration and a
    // product where every customer is granted the plan they picked for free, so
    // it is asserted here rather than trusted.
    //
    // `NODE_ENV` and `JWT_SECRET` are set on the environment before the module
    // is compiled, because provider factories run during compilation: setting
    // them afterwards would test nothing. `JWT_SECRET` is given a value so the
    // only thing that can reject the boot is the billing guard, and the
    // assertion below pins the message so a `JWT_SECRET` failure cannot stand in
    // for it.
    const previousNodeEnv = process.env.NODE_ENV;
    const previousSecret = process.env.JWT_SECRET;
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'a-secret-that-is-only-for-this-assertion';

    try {
      await expect(
        Test.createTestingModule({ imports: [AppModule] }).compile(),
      ).rejects.toThrow(/stub/i);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;

      if (previousSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousSecret;
    }
  });

  it('does not put a plan in force until the payment settles', async () => {
    const starter = await planNamed('Starter');
    const { token } = await registerVerified('deferred-owner@example.com');

    const pending = await asUser(token)(
      request(server).post(api('/subscription')),
    )
      .send({ planId: starter.id })
      .expect(202);

    // The customer is told to go and pay...
    expect(pending.body.purchase.status).toBe('pending');
    expect(pending.body.purchase.checkoutUrl).toMatch(
      new RegExp(`^https://checkout\\.test/${PURCHASE_PREFIX}`),
    );
    // ...and no plan is in force while they have not.
    expect(pending.body.subscription.planId).toBeNull();
    expect(pending.body.subscription.pendingPlan.id).toBe(starter.id);
    expect(pending.body.subscription.status).toBe('pending_payment');
  });

  it('applies the plan once the provider confirms the payment', async () => {
    const starter = await planNamed('Starter');
    const { token } = await registerVerified('settles-owner@example.com');

    const pending = await asUser(token)(
      request(server).post(api('/subscription')),
    )
      .send({ planId: starter.id })
      .expect(202);

    const reference = referenceOf(pending);

    const applied = await subscriptionService.confirmPurchase(reference);
    expect(applied).not.toBeNull();
    expect(applied!.subscription.planId).toBe(starter.id);
    expect(applied!.subscription.status).toBe('active');
    expect(applied!.subscription.pendingPlan).toBeNull();

    const current = await asUser(token)(request(server).get(api('/subscription')))
      .expect(200);
    expect(current.body.subscription.planId).toBe(starter.id);
    expect(current.body.subscription.status).toBe('active');
  });

  it('ignores a replayed or forged payment confirmation', async () => {
    const starter = await planNamed('Starter');
    const { token } = await registerVerified('replay-owner@example.com');

    const pending = await asUser(token)(
      request(server).post(api('/subscription')),
    )
      .send({ planId: starter.id })
      .expect(202);

    const reference = referenceOf(pending);

    expect(await subscriptionService.confirmPurchase(reference)).not.toBeNull();
    // Delivered twice: the second must not re-apply or move the plan.
    expect(await subscriptionService.confirmPurchase(reference)).toBeNull();
    // Never issued by this provider.
    expect(
      await subscriptionService.confirmPurchase('stub_purchase_made-up'),
    ).toBeNull();
  });

  it('will not change plan through an unpaid upgrade', async () => {
    const starter = await planNamed('Starter');
    const growth = await planNamed('Growth');
    const { token } = await registerVerified('upgrade-owner@example.com');

    // Buy Starter and pay for it, so there is a real plan to protect.
    const bought = await asUser(token)(
      request(server).post(api('/subscription')),
    )
      .send({ planId: starter.id })
      .expect(202);
    await subscriptionService.confirmPurchase(referenceOf(bought));

    const upgrading = await asUser(token)(
      request(server).patch(api('/subscription/plan')),
    )
      .send({ planId: growth.id })
      .expect(202);

    // The paid Starter plan is still what the subscription carries: asking is
    // not owning.
    expect(upgrading.body.subscription.planId).toBe(starter.id);
    expect(upgrading.body.subscription.pendingPlan.id).toBe(growth.id);

    const beforeConfirmation = await asUser(token)(
      request(server).get(api('/subscription')),
    ).expect(200);
    expect(beforeConfirmation.body.subscription.planId).toBe(starter.id);

    await subscriptionService.confirmPurchase(referenceOf(upgrading));

    const afterConfirmation = await asUser(token)(
      request(server).get(api('/subscription')),
    ).expect(200);
    expect(afterConfirmation.body.subscription.planId).toBe(growth.id);
  });

  it('refuses to consume capacity while a purchase is pending', async () => {
    const starter = await planNamed('Starter');
    const { token } = await registerVerified('pending-capacity@example.com');

    await asUser(token)(request(server).post(api('/subscription')))
      .send({ planId: starter.id })
      .expect(202);

    // status is pending_payment: there is no paid plan behind this, so there is
    // no capacity to grant.
    const refused = await asUser(token)(
      request(server).post(api('/organizations')),
    )
      .send({ name: 'Should Not Exist' })
      .expect(400);

    expect(refused.body.message).toContain('pending_payment');
  });

  it('stops granting capacity once a trial has run out', async () => {
    const starter = await planNamed('Starter');
    const { token } = await registerVerified('lapsed-trial@example.com');

    const trial = await asUser(token)(
      request(server).post(api('/subscription')),
    )
      .send({ planId: starter.id, status: 'trial' })
      .expect(200);

    expect(trial.body.subscription.status).toBe('trial');
    expect(trial.body.subscription.isTrialExpired).toBe(false);
    expect(trial.body.subscription.trialEndsAt).not.toBeNull();

    // Working normally while the trial runs.
    const organization = await asUser(token)(
      request(server).post(api('/organizations')),
    )
      .send({ name: 'During Trial' })
      .expect(201);

    // Backdate the trial end rather than waiting two weeks for it.
    await dataSource.query(
      `UPDATE tenants SET trial_ends_at = now() - interval '1 minute' WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
      ['lapsed-trial@example.com'],
    );

    const expired = await asUser(token)(
      request(server).get(api('/subscription')),
    ).expect(200);
    expect(expired.body.subscription.isTrialExpired).toBe(true);
    expect(expired.body.subscription.status).toBe('trial');

    const refused = await asUser(token)(
      request(server).post(api('/organizations')),
    )
      .send({ name: 'After Trial' })
      .expect(400);
    expect(refused.body.message).toContain('The trial ended on');

    // The organization created during the trial is untouched: an expired trial
    // stops new work, it does not confiscate what was already done.
    const stillThere = await asUser(token)(
      request(server).get(api(`/organizations/${organization.body.id}`)),
    ).expect(200);
    expect(stillThere.body.name).toBe('During Trial');
  });

  it('voids the outstanding purchase when a pending subscription is cancelled', async () => {
    const starter = await planNamed('Starter');
    const { token } = await registerVerified('cancel-owner@example.com');

    const pending = await asUser(token)(
      request(server).post(api('/subscription')),
    )
      .send({ planId: starter.id })
      .expect(202);
    const reference = referenceOf(pending);

    await asUser(token)(request(server).delete(api('/subscription'))).expect(200);

    const cancelled = await asUser(token)(
      request(server).get(api('/subscription')),
    ).expect(200);
    expect(cancelled.body.subscription.status).toBe('cancelled');
    expect(cancelled.body.subscription.pendingPlan).toBeNull();

    // The customer is told the purchase is abandoned, rather than the application
    // quietly forgetting it: a checkout left live is a checkout they can still
    // pay, which would restore a plan they just cancelled.
    expect(billing.voided).toEqual([reference]);

    // And a payment that somehow still lands cannot resurrect it.
    expect(await subscriptionService.confirmPurchase(reference)).toBeNull();
  });
});
