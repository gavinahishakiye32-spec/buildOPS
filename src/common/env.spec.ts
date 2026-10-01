import { ConfigService } from '@nestjs/config';
import { getSecret, isProduction } from './env.js';

/**
 * Minimal `ConfigService` stand-in: `get` returns the value for a key and
 * ignores the default second argument, which is all `env.ts` uses.
 */
function configWith(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as ConfigService;
}

describe('getSecret', () => {
  it('returns the configured value', () => {
    const config = configWith({ JWT_SECRET: 'from-env' });

    expect(getSecret(config, 'JWT_SECRET', 'fallback-secret')).toBe('from-env');
  });

  it('trims surrounding whitespace', () => {
    const config = configWith({ JWT_SECRET: '  spaced  ' });

    expect(getSecret(config, 'JWT_SECRET', 'fallback-secret')).toBe('spaced');
  });

  it('falls back with a warning outside production', () => {
    const config = configWith({ NODE_ENV: 'development' });

    expect(getSecret(config, 'JWT_SECRET', 'fallback-secret')).toBe(
      'fallback-secret',
    );
  });

  it('falls back when NODE_ENV is unset', () => {
    expect(getSecret(configWith({}), 'JWT_SECRET', 'fallback-secret')).toBe(
      'fallback-secret',
    );
  });

  it('throws in production so a shipped default cannot sign real tokens', () => {
    const config = configWith({ NODE_ENV: 'production' });

    expect(() => getSecret(config, 'JWT_SECRET', 'fallback-secret')).toThrow(
      /JWT_SECRET is required when NODE_ENV=production/,
    );
  });

  it('throws in production when the value is only whitespace', () => {
    const config = configWith({ NODE_ENV: 'production', JWT_SECRET: '   ' });

    expect(() => getSecret(config, 'JWT_SECRET', 'fallback-secret')).toThrow();
  });

  it('accepts an explicit value in production', () => {
    const config = configWith({ NODE_ENV: 'production', JWT_SECRET: 'real' });

    expect(getSecret(config, 'JWT_SECRET', 'fallback-secret')).toBe('real');
  });
});

describe('isProduction', () => {
  it.each([
    ['production', true],
    ['development', false],
    ['test', false],
    [undefined, false],
  ])('reads NODE_ENV=%s as %s', (nodeEnv, expected) => {
    expect(isProduction(configWith({ NODE_ENV: nodeEnv }))).toBe(expected);
  });
});
