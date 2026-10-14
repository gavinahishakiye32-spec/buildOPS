import { describe, it, expect } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { NotificationQueryDto } from './notification.dto.js';

/**
 * `unread` arrives as a query string, so the transform is what decides whether
 * `?unread=false` means "all notifications" or (wrongly) "only the unread
 * ones". The same pattern the dashboard and time-entry query DTOs use is what
 * keeps the two in step.
 */
describe('NotificationQueryDto', () => {
  const parse = (unread: unknown): boolean | undefined =>
    plainToInstance(NotificationQueryDto, { unread }).unread;

  it('treats the query string "false" as false', () => {
    expect(parse('false')).toBe(false);
  });

  it('treats the query string "true" as true', () => {
    expect(parse('true')).toBe(true);
  });

  it('passes a real boolean through unchanged', () => {
    expect(parse(false)).toBe(false);
    expect(parse(true)).toBe(true);
  });

  it('leaves the filter unset when the parameter is absent', () => {
    expect(plainToInstance(NotificationQueryDto, {}).unread).toBeUndefined();
  });
});
