# BuildOps API

NestJS + TypeORM backend powering BuildOps (multi-tenant project/task/time tracking with role-based permissions).

## Features

- JWT auth with email verification and password reset
- Multi-tenant model: Tenant (subscription) → Organization → Users, Roles, Permissions
- Resources: Clients, Projects, Teams, Badges, Tasks/Subtasks, Time Entries, Time Complexity, Dashboard
- Global validation, CORS, Helmet, rate limiting
- OpenAPI 3.0 (Swagger UI) + generated reference docs

## Quick Start

```bash
cp .env.example .env
# fill in DB_* and JWT_SECRET; SMTP optional for local testing
npm install
npm run start:dev
```

API base: `http://localhost:3000/api/v1`
Swagger: `http://localhost:3000/api/v1/docs`
OpenAPI JSON: `http://localhost:3000/api/v1/docs-json`

## Environment

See `.env.example` for all variables. Key ones: `DB_HOST/PORT/USER/PASS/NAME`, `JWT_SECRET`, `JWT_EXPIRATION`, `APP_BASE_URL` (for email links), SMTP (leave blank locally — email send failures are logged, not thrown).

`JWT_SECRET` has no safe default: the app **refuses to boot** when `NODE_ENV=production` and it is unset, rather than signing tokens with a value published in this repository. Outside production it falls back to a development default and logs a warning, which keeps `npm test` and a fresh clone working.

## Architecture

Domain modules under `src/` (feature-first): `auth`, `tenant`, `organization`, `role`, `team`, `client`, `project`, `badge`, `task`, `subtask` (no standalone module/routes), `time-entry`, `time-complexity`, `dashboard`, `plan`, `user`, `mail`. 
Global guards: `ThrottlerGuard` (rate limiting). Org-scoped routes require `x-organization-id` or `:organizationId` param via `@Protected()`, permissions via `@RequirePermissions(...)`.

## Commands

```bash
npm run lint        # oxlint src/ test/
npm test            # unit tests (Jest, ESM)
npm run test:e2e    # end-to-end tests (Jest, ESM)
npm run build       # Nest build → dist/
npm run start:prod  # node dist/main
npm run format      # Prettier

npm run docs:openapi     # regen docs/openapi.json + docs/api-reference.md
npm run docs:reference   # regen docs/api-reference.md only
```

## Documentation

- `docs/specification.md` — original architecture/spec (archival)
- `docs/frontend-guide.md` — frontend integration (auth, org context, errors, pagination, examples)
- `docs/api-reference.md` — generated endpoint reference (do not edit)
- `docs/openapi.json` — machine-readable contract (do not edit; regen via docs:openapi)
- `schema.sql` — database schema

## Testing Notes

Unit specs live next to code (`*.spec.ts`). E2E in `test/*.e2e-spec.ts`. `test/openapi-artifact.e2e-spec.ts` enforces spec drift: committed OpenAPI and API reference must match generated ones. `OPENAPI_WRITE=1` is used by `npm run docs:openapi` to rewrite committed artifacts.

## Conventions

- Paths under `/api/v1`. Pagination `{ items, total, page, limit, totalPages }`. Errors use `{ statusCode, error, message, timestamp, path }` (message string or string[]).
- Strict validation (whitelist + forbidNonWhitelisted). Dates ISO-8601; UUIDs for IDs.
- All org-scoped mutations enforce same-organization ownership and required permissions.
