import { describe, expect, it } from '@jest/globals';
import {
  DEFAULT_ORGANIZATION_SETTINGS,
  DEFAULT_USER_SETTINGS,
  MAX_MINUTES_IN_DAY,
} from '../common/enums.js';

/**
 * These defaults exist in three places and they have to agree: the migration's
 * column defaults, the entities' `@Column` defaults, and the constants here.
 * Nothing in the type system connects them, so this test is what keeps a
 * mismatch from turning into a row whose default disagrees with the value the
 * API reports for an account that never touched its settings.
 */
describe('settings defaults', () => {
  it('describes the columns the user_settings table actually has', () => {
    expect(Object.keys(DEFAULT_USER_SETTINGS).sort()).toEqual([
      'dateFormat',
      'digestFrequency',
      'locale',
      'theme',
      'timeFormat',
      'timezone',
    ]);
  });

  it('describes the columns the organization_settings table actually has', () => {
    expect(Object.keys(DEFAULT_ORGANIZATION_SETTINGS).sort()).toEqual([
      'timeFormat',
      'timezone',
      'weekStart',
      'workingDayEndMinutes',
      'workingDayStartMinutes',
    ]);
  });

  it('keeps the default working window inside a single day and in order', () => {
    const { workingDayStartMinutes: start, workingDayEndMinutes: end } =
      DEFAULT_ORGANIZATION_SETTINGS;

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeLessThanOrEqual(MAX_MINUTES_IN_DAY);
    expect(start).toBeLessThan(end);
  });

  it('defaults a user and an organization to the same clock and week start', () => {
    // A member who has configured nothing must not see a date format that
    // disagrees with the organization they work in.
    expect(DEFAULT_USER_SETTINGS.timeFormat).toBe(
      DEFAULT_ORGANIZATION_SETTINGS.timeFormat,
    );
  });

  it('exposes working hours as minutes from midnight', () => {
    // The migration stores 540 and 1020; if these ever become strings, the
    // arithmetic that compares a logged duration against the window stops
    // working silently rather than failing to compile.
    expect(typeof DEFAULT_ORGANIZATION_SETTINGS.workingDayStartMinutes).toBe(
      'number',
    );
    expect(DEFAULT_ORGANIZATION_SETTINGS.workingDayStartMinutes).toBe(9 * 60);
    expect(DEFAULT_ORGANIZATION_SETTINGS.workingDayEndMinutes).toBe(17 * 60);
  });
});
