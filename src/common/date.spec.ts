import { describe, expect, it } from '@jest/globals';
import { toIsoDate } from './date.js';

describe('toIsoDate', () => {
  it('returns null for the empty values', () => {
    expect(toIsoDate(null)).toBeNull();
    expect(toIsoDate(undefined)).toBeNull();
    expect(toIsoDate('')).toBeNull();
  });

  it('formats a Date as its UTC calendar date', () => {
    expect(toIsoDate(new Date('2026-12-01T00:00:00.000Z'))).toBe('2026-12-01');
    expect(toIsoDate(new Date('2026-12-01T23:30:00.000Z'))).toBe('2026-12-01');
  });

  it('passes through the string a `date` column already returned', () => {
    expect(toIsoDate('2026-12-01')).toBe('2026-12-01');
  });

  it('parses a timestamp string down to its UTC date', () => {
    expect(toIsoDate('2026-12-01T23:30:00.000Z')).toBe('2026-12-01');
  });

  it('returns null for a value that is not a date', () => {
    expect(toIsoDate('not-a-date')).toBeNull();
  });
});
