import type { ConfigService } from '@nestjs/config';

import { buildEmailLink, type EmailLinkKind } from './mail.links.js';

/** What one email attempt did, reported outside production only. */
export type EmailDelivery = Partial<{ emailSent: boolean; emailError: string }>;

/**
 * True outside production: there the API answers with the raw token and link
 * and reports the SMTP outcome, so a local flow can be driven without a working
 * mail server. Production never includes them -- there the token exists only in
 * the email, which is the whole point of hashing it at rest.
 *
 * Extracted from `AuthService` so every flow that emails a token answers the
 * same question the same way: a second implementation of this check would be a
 * second chance to leak a token into a production body.
 */
export function exposeEmailTokens(config: ConfigService): boolean {
  return config.get<string>('NODE_ENV') !== 'production';
}

/**
 * Sends one email and reports what happened, outside production only.
 *
 * Outside production the send is awaited, so the response can say whether the
 * mail actually left (`emailSent` / `emailError`) instead of claiming success
 * while SMTP quietly refused it -- the failure mode that leaves a caller staring
 * at a `201` and an empty inbox. In production the send stays fire-and-forget:
 * an invitation must not wait on, or be failed by, the mail server, and
 * `MailService` has already logged the error. Production therefore gets no
 * delivery report at all.
 */
export async function dispatchEmail(
  config: ConfigService,
  send: () => Promise<void>,
): Promise<EmailDelivery> {
  if (!exposeEmailTokens(config)) {
    void send().catch(() => undefined);
    return {};
  }

  try {
    await send();
    return { emailSent: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { emailSent: false, emailError: message };
  }
}

/**
 * The deep link for a token, built from the same configuration the auth flow
 * uses so a locally copied link and the emailed one are identical.
 */
export function emailLink(
  config: ConfigService,
  kind: EmailLinkKind,
  token: string,
): string {
  return buildEmailLink(config.get<string>('APP_BASE_URL'), kind, token);
}
