import { describe, expect, it } from '@jest/globals';
import {
  DEFAULT_LIMIT,
  DEFAULT_PAGE,
  resolvePage,
  toPaginated,
} from './pagination.dto.js';

describe('pagination', () => {
  it('falls back to the documented defaults', () => {
    expect(resolvePage({})).toEqual({
      page: DEFAULT_PAGE,
      limit: DEFAULT_LIMIT,
      skip: 0,
    });
  });

  it('computes the offset of the requested page', () => {
    expect(resolvePage({ page: 3, limit: 10 })).toEqual({
      page: 3,
      limit: 10,
      skip: 20,
    });
  });

  it('builds a flat paginated payload', () => {
    expect(toPaginated(['a', 'b'], 5, 2, 2)).toEqual({
      items: ['a', 'b'],
      total: 5,
      page: 2,
      limit: 2,
      totalPages: 3,
    });
  });

  it('never divides by zero', () => {
    expect(toPaginated([], 0, 1, 0).totalPages).toBe(0);
  });
});
