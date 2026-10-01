import { describe, expect, it } from '@jest/globals';
import {
  formatInterval,
  parseIntervalSeconds,
  secondsToInterval,
} from './duration.js';

describe('duration', () => {
  describe('parseIntervalSeconds', () => {
    it('parses the clock literals returned by PostgreSQL', () => {
      expect(parseIntervalSeconds('02:00:00')).toBe(7200);
      expect(parseIntervalSeconds('04:30:00')).toBe(16200);
      expect(parseIntervalSeconds('-00:15:00')).toBe(-900);
    });

    it('parses unit words mixed with a clock literal', () => {
      expect(parseIntervalSeconds('1 day 04:30:00')).toBe(102600);
      expect(parseIntervalSeconds('3 mons 2 days')).toBe(
        3 * 2592000 + 2 * 86400,
      );
    });

    it('parses the object form the pg driver returns for interval columns', () => {
      expect(parseIntervalSeconds({ hours: 2 })).toBe(7200);
      expect(
        parseIntervalSeconds({ days: 1, hours: 4, minutes: 30, seconds: 15 }),
      ).toBe(102615);
      expect(parseIntervalSeconds({ seconds: -30 })).toBe(-30);
    });

    it('is defensive with empty input', () => {
      expect(parseIntervalSeconds(null)).toBe(0);
      expect(parseIntervalSeconds(undefined)).toBe(0);
      expect(parseIntervalSeconds('')).toBe(0);
      expect(parseIntervalSeconds({})).toBe(0);
    });
  });

  describe('formatInterval', () => {
    it('renders a canonical PostgreSQL literal for the driver object', () => {
      expect(formatInterval({ hours: 2 })).toBe('02:00:00');
      expect(formatInterval({ days: 1, hours: 4 })).toBe('1 days 04:00:00');
    });

    it('normalises string input', () => {
      expect(formatInterval('7200 seconds')).toBe('02:00:00');
      expect(formatInterval(null)).toBeNull();
    });
  });

  it('round trips seconds through the interval literal', () => {
    expect(parseIntervalSeconds(secondsToInterval(5400))).toBe(5400);
  });
});
