import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { RawBodyRequest } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { StripeWebhookVerifier } from './stripe-webhook.verifier.js';
import { SubscriptionService } from '../subscription/subscription.service.js';
import {
  ApiErrors,
  ApiRateLimited,
} from '../common/decorators/api-errors.decorator.js';

/**
 * The settlement half of the billing seam: Stripe calls this route, the
 * signature is checked against the raw bytes, and the reference Stripe names is
 * handed to `SubscriptionService.confirmPurchase` -- which asks the provider
 * (not the request body) what that reference was for.
 *
 * The route is public because its caller is Stripe's servers, not a browser:
 * the signature *is* the authentication, and a JWT requirement would only mean
 * the endpoint cannot be reached by the one party that needs it. It is also the
 * reason `main.ts` creates the application with `rawBody: true` -- a signature
 * over JSON that has been re-serialised by a body parser cannot match the one
 * Stripe computed.
 */
@ApiRateLimited()
@ApiTags('billing')
@Controller('billing')
export class BillingWebhookController {
  constructor(
    private readonly verifier: StripeWebhookVerifier,
    private readonly subscriptions: SubscriptionService,
  ) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Receive a Stripe webhook',
    description:
      'Verifies the Stripe-Signature header against the raw request body using STRIPE_WEBHOOK_SECRET, then settles the purchase the event names. A signed delivery for an unknown or unpaid checkout session is acknowledged with 200 and changes nothing; an unsigned, badly signed or unverifiable delivery is rejected with 400. Returns 429 under the same rate limit as the rest of the API.',
  })
  @ApiOkResponse({
    description:
      'Delivery acknowledged. The plan is applied only when the event settled a purchase this application is waiting on.',
    schema: {
      type: 'object',
      properties: { received: { type: 'boolean' } },
      required: ['received'],
    },
  })
  @ApiErrors(400)
  async receive(
    @Req() request: RawBodyRequest<Request>,
  ): Promise<{ received: boolean }> {
    const rawBody = request.rawBody;

    if (!rawBody) {
      // Fail closed: without the bytes Stripe signed, the header proves
      // nothing, and the only honest answers are "not verified" or "400".
      throw new BadRequestException(
        'Raw request body unavailable. The application must be created with the rawBody option to verify webhook signatures.',
      );
    }

    const event = this.verifier.verify(
      rawBody,
      request.headers['stripe-signature'],
    );

    // Deliveries that settle a purchase. A session completed with an async
    // payment method is complete but unpaid at first and is settled later by
    // `async_payment_succeeded`; both arrive here, and `confirmPurchase` -- not
    // this route -- is what decides whether the money is actually in.
    if (
      event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.async_payment_succeeded'
    ) {
      // Anything thrown here propagates to a 500, which is deliberate: Stripe
      // retries a non-2xx delivery, and a database outage must not become a
      // payment that was accepted and silently dropped.
      await this.subscriptions.confirmPurchase(event.data.object.id);
    }

    // Acknowledged regardless of whether the event mattered. Stripe retries
    // only what it is not told to stop retrying, and an event for another
    // product on the same account will never become applicable here.
    return { received: true };
  }
}
