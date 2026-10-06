import { API_PREFIX } from '../bootstrap.js';

/**
 * Fallback when neither `APP_BASE_URL` nor an explicit origin is configured.
 * It is the API's own origin, so an unconfigured deployment still produces a
 * link that resolves -- to JSON, which is why `.env.example` asks for
 * `APP_BASE_URL` to point at the frontend instead.
 */
export const DEFAULT_APP_BASE_URL = 'http://localhost:3000';

export type EmailLinkKind = 'verify-email' | 'reset-password' | 'accept-invitation';

/**
 * The API path each kind of token is read from.
 *
 * One table rather than a path stitched together at the call site: the emailed
 * link has to land on a route that actually exists, and `accept-invitation`
 * lives under `/invitations` rather than under `/auth` because the invitation is
 * an organization operation that happens to be reachable before the invitee has
 * an account.
 */
const PATH_BY_KIND: Record<EmailLinkKind, string> = {
  'verify-email': 'auth/verify-email',
  'reset-password': 'auth/reset-password',
  'accept-invitation': 'invitations/accept',
};

/**
 * Builds the deep link that carries a verification, reset or invitation token.
 *
 * One implementation for every producer of the link: the HTML email
 * (MailService) and the non-production JSON response (AuthService /
 * InvitationService), so the link copied out of an API response is byte-for-byte
 * the link the email contains.
 */
export function buildEmailLink(
  origin: string | undefined | null,
  kind: EmailLinkKind,
  token: string,
): string {
  const base = (origin ?? DEFAULT_APP_BASE_URL).replace(/\/+$/, '');
  return `${base}/${API_PREFIX}/${PATH_BY_KIND[kind]}?token=${token}`;
}
