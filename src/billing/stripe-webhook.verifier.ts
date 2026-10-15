import { BadRequestException, Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Stripe from 'stripe';
import { STRIPE_CLIENT } from './billing.tokens.js';

/**
 * Verifies that a request on the billing webhook really came from Stripe.
 *
 * Verification is a provider-specific concern -- a "generic" webhook endpoint
 * would have to skip it, which is why the route lives with the billing provider
 * rather than in a shared controller. Nothing else about the request is
 * trusted: the signature covers the raw bytes, and the only thing taken from
 * the parsed body is an event id Stripe itself produced.
 *
 * The comparison is Stripe's own (`constructEvent`), including the five-minute
 * tolerance that stops a captured-and-replayed delivery from being accepted
 * tomorrow. Reimplementing that in the application would be a second,
 * less-tested copy of security-critical code.
 */
@Injectable()
export class StripeWebhookVerifier {
  constructor(
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe,
    private readonly config: ConfigService,
  ) {}

  /**
   * Returns the event a signed delivery carries.
   *
   * Every failure is a 400 rather than a 500: a request that fails here was
   * never a legitimate event, so Stripe (or whatever sent it) should see a
   * rejection, not a retry. A missing signing secret is also a 400 -- the route
   * cannot tell a forged delivery from a real one without it, and answering
   * "verified" would be the one outcome that matters.
   */
  verify(rawBody: Buffer | string, signature: unknown): Stripe.Event {
    const secret = this.config.get<string>('STRIPE_WEBHOOK_SECRET')?.trim();

    if (!secret) {
      throw new BadRequestException(
        'Webhook signing secret is not configured (STRIPE_WEBHOOK_SECRET); refusing to accept an unverifiable delivery.',
      );
    }

    if (!signature || typeof signature !== 'string') {
      throw new BadRequestException(
        'Missing or malformed Stripe-Signature header.',
      );
    }

    try {
      return this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        secret,
      );
    } catch {
      // The reason (stale timestamp, wrong secret, edited body) is deliberately
      // not echoed: it is a diagnostic for whoever holds the signing secret,
      // and there is exactly one of those, on the Stripe dashboard.
      throw new BadRequestException('Webhook signature verification failed.');
    }
  }
}
