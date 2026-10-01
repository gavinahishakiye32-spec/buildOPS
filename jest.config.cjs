const preset = require('ts-jest/presets/default-esm/jest-preset.js');

/** @type {import('jest').Config} */
module.exports = {
  ...preset,
  rootDir: '.',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // @nestjs/throttler is CommonJS while Nest is ESM: loading it first breaks
  // the require(esm) cycle Jest otherwise hits.
  setupFiles: ['<rootDir>/test/setup/throttler-first.mjs'],
};