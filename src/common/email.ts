/** Normalizes an email before uniqueness checks (spec §4.1). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}