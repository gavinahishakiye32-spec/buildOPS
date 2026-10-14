/**
 * Reduces a value to the calendar date (`YYYY-MM-DD`) it represents.
 *
 * PostgreSQL's `date` type round-trips through TypeORM as a string even though
 * entities declare `Date | null`, while the create paths build a real `Date` in
 * memory before it is ever saved. A due date read after a save can therefore be
 * either, so callers hand it here instead of calling `.toISOString()` on a value
 * that may be a string.
 *
 * The result is always date-only and UTC: these are calendar dates, not
 * instants, and a date-only string is parsed as UTC midnight.
 */
export function toIsoDate(
  value: Date | string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}
