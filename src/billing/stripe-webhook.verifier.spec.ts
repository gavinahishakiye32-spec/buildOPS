import { describe, it, expect, beforeEach } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { StripeWebhookVerifier } from './stripe-webhook.verifier.js';

const SECRET = 'whsec_test_secret';
const PAYLOAD = JSON.stringify({
  id: 'evt_1',
  object: 'event',
  type: 'checkout.session.completed',
  data: { object: { id: 'cs_test_1', object: 'checkout_session' } },
});

describe('StripeWebhookVerifier', () => {
  const stripe = new Stripe('sk_test_verifier');
  let secret: string | undefined;

  const verifier = (): StripeWebhookVerifier =>
    new StripeWebhookVerifier(stripe, {
      get: (key: string) => (key === 'STRIPE_WEBHOOK_SECRET' ? secret : undefined),
    } as ConfigService);

  const signature = (payload = PAYLOAD, signingSecret = SECRET): string =>
    stripe.webhooks.generateTestHeaderString({
      payload,
      secret: signingSecret,
    });

  beforeEach(() => {
    secret = SECRET;
  });

  it('accepts a delivery signed with the configured secret', () => {
    const event = verifier().verify(PAYLOAD, signature());

    expect(event.id).toBe('evt_1');
    expect(event.type).toBe('checkout.session.completed');
  });

  it('rejects a delivery when no signing secret is configured', () => {
    secret = undefined;

    expect(() => verifier().verify(PAYLOAD, signature())).toThrow(
      /STRIPE_WEBHOOK_SECRET/,
    );
  });

  it('rejects a delivery with no signature header', () => {
    expect(() => verifier().verify(PAYLOAD, undefined)).toThrow(
      'Missing or malformed Stripe-Signature header.',
    );
  });

  it('rejects a delivery signed with another secret', () => {
    expect(() =>
      verifier().verify(PAYLOAD, signature(PAYLOAD, 'whsec_elsewhere')),
    ).toThrow('Webhook signature verification failed.');
  });

  it('rejects a body that does not match the signature', () => {
    const tampered = PAYLOAD.replace('cs_test_1', 'cs_test_2');

    expect(() => verifier().verify(tampered, signature())).toThrow(
      'Webhook signature verification failed.',
    );
  });

  it('rejects a replayed delivery older than the tolerance', () => {
    const stale = stripe.webhooks.generateTestHeaderString({
      payload: PAYLOAD,
      secret: SECRET,
      timestamp: Math.floor(Date.now() / 1000) - 600,
    });

    expect(() => verifier().verify(PAYLOAD, stale)).toThrow(
      'Webhook signature verification failed.',
    );
  });

  it('answers with the 400 envelope rather than a 500', () => {
    try {
      verifier().verify(PAYLOAD, 'v1=not-a-real-signature');
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Webhook signature verification failed.',
      });
    }
  });
});
