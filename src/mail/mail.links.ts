import { API_PREFIX } from '../bootstrap.js';

/**
 * Fallback when neither `APP_BASE_URL` nor an explicit origin is configured.
 * It is the API's own origin, so an unconfigured deployment still produces a
 * link that resolves -- to JSON, which is why `.env.example` asks for
 * `APP_BASE_URL` to point at the frontend instead.
 */
export const DEFAULT_APP_BASE_URL = 'http://localhost:3000';

export type EmailLinkKind = 'verify-email' | 'reset-password';

/**
 * Builds the deep link that carries a verification or reset token.
 *
 * One implementation for both producers of the link: the HTML email
 * (MailService) and the non-production JSON response (AuthService), so the link
 * copied out of an API response is byte-for-byte the link the email contains.
 */
export function buildEmailLink(
  origin: string | undefined | null,
  kind: EmailLinkKind,
  token: string,
): string {
  const base = (origin ?? DEFAULT_APP_BASE_URL).replace(/\/+$/, '');
  return `${base}/${API_PREFIX}/auth/${kind}?token=${token}`;
}
