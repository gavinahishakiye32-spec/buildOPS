// Points the e2e suites at a database of their own.
//
// Every suite calls `resetDatabase`, which TRUNCATEs every table. Until this
// file existed they did that to whatever `DB_DATABASE` said — which is the same
// database the application runs against, so running the test suite emptied the
// developer's working data. That is not an acceptable default for a command
// that is meant to be run constantly, so the suites are moved onto a separate
// database here, and the name is derived rather than configured so it cannot
// drift from the real one.
//
// Runs before any test file, so it has to complete before `DataSource` is
// constructed in a suite's `beforeAll`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

// Jest does not load `.env` before setup files, so the connection settings have
// to be read from it here or the derived name would not match the database the
// application actually uses. Parsed directly rather than through
// `process.loadEnvFile`, which leaves an already-present empty value alone and
// so silently falls back to the default below.
if (!process.env.DB_DATABASE) {
  const envFile = fileURLToPath(new URL('../../.env', import.meta.url));

  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}

const target = process.env.DB_DATABASE ?? 'ops';
const testDatabase = `${target}_test`;

if (testDatabase !== target) {
  // The suites connect as the configured user, which may not be allowed to
  // create databases. If it already exists this is skipped entirely, so a
  // restricted account works from the second run onwards.
  const admin = new Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: 'postgres',
  });

  try {
    await admin.connect();
    const { rows } = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [testDatabase],
    );

    if (rows.length === 0) {
      await admin.query(`CREATE DATABASE "${testDatabase}"`);
      console.log(`[setup] created test database ${testDatabase}`);
    }
  } catch (error) {
    console.warn(
      `[setup] could not ensure ${testDatabase} exists (${error.message}). ` +
        'Create it by hand if the suites cannot connect.',
    );
  } finally {
    await admin.end().catch(() => undefined);
  }

  process.env.DB_DATABASE = testDatabase;
}