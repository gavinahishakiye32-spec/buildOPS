# BuildOps API

NestJS + TypeORM backend powering BuildOps (multi-tenant project/task/time tracking with role-based permissions).

## Features

- JWT auth with email verification, password reset, and rotating refresh-token sessions
  (httpOnly cookie + CSRF double-submit, with per-device session list and "log out
everywhere")
- Multi-tenant model: Subscription → Organization → Users, Roles, Permissions
- Resources: Clients, Projects, Teams, Badges, Tasks/Subtasks, Milestones, Time Entries, Time Complexity, Dashboard, Activity
- In-app notifications as the "what's new" feed: targeted assignment/status events
  plus lifecycle broadcasts (created/updated/deleted) delivered to owners and
  project managers, with unread counts and read/read-all inbox routes
- Activity analysis: an append-only "who did what" trail written in the same
  transaction as every mutation, surfaced as timeline, leaderboard, breakdown
  and feed projections behind `analytics.view`
- Soft delete with a trash and a restore route for every resource that can be
  deleted; cascading deletes are recoverable and report how many rows they took
- Global validation, CORS, Helmet, rate limiting
- OpenAPI 3.0 (Swagger UI) as the single documentation source

## Quick Start

```bash
cp .env.example .env
# fill in DB_* and JWT_SECRET; SMTP optional for local testing
pnpm install
pnpm run start:dev
```

API base: `http://localhost:3000/api/v1`
Swagger: `http://localhost:3000/api/v1/docs`
OpenAPI JSON: `http://localhost:3000/api/v1/docs-json`

## Environment

See `.env.example` for all variables. Key ones: `DB_HOST/PORT/USER/PASS/NAME`, `JWT_SECRET`, `JWT_EXPIRATION`, `REFRESH_TOKEN_TTL_DAYS`,
`ALLOWED_ORIGINS` (mandatory in production, since the refresh token is a cookie),
`APP_BASE_URL` (for email links), SMTP (leave blank locally — email send failures are logged, not thrown),
`SOFT_DELETE_RETENTION_DAYS` (30) and `PURGE_INTERVAL_HOURS` (24).

Outside `NODE_ENV=production`, verification and reset flows do not need SMTP at all: `POST /auth/register`, `POST /auth/forgot-password` and the `403` of an unverified login return the raw token and link in the JSON body, together with `emailSent`/`emailError` reporting what the mail server did. Production responses never contain a token — there it exists only in the email.

`JWT_SECRET` has no safe default: the app **refuses to boot** when `NODE_ENV=production` and it is unset, rather than signing tokens with a value published in this repository. Outside production it falls back to a development default and logs a warning, which keeps `pnpm test` and a fresh clone working.

## Architecture

Domain modules under `src/` (feature-first): `auth`, `subscription`, `organization`, `role`, `team`, `client`, `project`, `badge`, `task`, `subtask`, `milestone`, `notification`, `time-entry`, `time-complexity`, `dashboard`, `activity`, `plan`, `user`, `mail`.
Global guards: `ThrottlerGuard` (rate limiting). Org-scoped routes require `x-organization-id` or `:organizationId` param via `@Protected()`, permissions via `@RequirePermissions(...)`.

## Commands

```bash
pnpm run lint        # oxlint src/ test/
pnpm test            # unit tests (Jest, ESM)
pnpm run test:e2e    # end-to-end tests (Jest, ESM) — needs PostgreSQL
pnpm run test:cov    # unit coverage → coverage/
pnpm run build       # Nest build → dist/
pnpm run start:prod  # node dist/main
pnpm run format      # Prettier

pnpm run migration:run       # apply pending migrations (builds first)
pnpm run migration:revert    # roll back the last migration
pnpm run migration:generate  # scaffold a migration from entity changes
pnpm run migration:show      # list applied/pending migrations
pnpm run docs:openapi     # regen docs/openapi.json
```

The e2e suite needs a reachable PostgreSQL instance and serializes itself
(`maxWorkers: 1`), because the suites share one database and truncate it between
runs. `test/contract.e2e-spec.ts` is the one to read first: it boots the app,
reads the live OpenAPI document and fails if any published operation returns a
status it does not declare, or if a declared error never actually happens.

## Database

The schema is owned by versioned TypeORM migrations in `src/database/migrations/`,
applied at boot (`migrationsRun`). `synchronize` is off: it derives DDL from the
entities on every start, so a renamed column was a silently dropped column and no
schema change could be reviewed before it touched real data.

`src/database/data-source.ts` holds the single connection definition shared by the
app and the `typeorm` CLI, so `pnpm run migration:*` operates on the same database
the app uses. To change the schema: edit the entities, then
`pnpm run migration:generate -- src/database/migrations/NameOfChange`, and review
the generated SQL before committing it.

`schema.sql` is an archival snapshot of the original design, not the live schema.

## Soft delete

Clients, projects, tasks, subtasks, time entries, badges and teams are
soft-deleted: `DELETE` hides a record from every ordinary read, `GET /{resource}/trash`
lists what is hidden, and `POST /{resource}/{id}/restore` brings a record back.
Restoring returns exactly what went down with the delete that flagged the record,
and a child whose parent is still deleted cannot be restored on its own.

Deleting a project, task or subtask takes the work and time logged under it, and
answers `409` until the request carries `?confirm=cascade`; the `200` then reports
`{ message, deleted }` so the caller can see the size of what it removed. A
deleted client's email is released for reuse, so restoring it can be `409` until
the address is free.

Trash is not forever. `SoftDeletePurgeService` permanently deletes rows older
than `SOFT_DELETE_RETENTION_DAYS` in batches (`0` or less disables it), children
first.

`DELETE /organizations/{organizationId}` is the one permanent delete: it also
empties the trash, and requires the organization name as `?confirm=<name>`.

## Billing

`POST /subscription` and `PATCH /subscription/plan` do not grant a paid plan
directly. They ask a `BillingProvider` (`src/billing/billing-provider.ts`) to take
payment, and the plan is applied only once the money has arrived. The response
status says which happened, and it is the part of the contract a client should
branch on:

- `200` — paid, plan in force, `usage` figures are final.
- `202` — `purchase.checkoutUrl` to visit. `subscription.planId` still holds the
  *previous* plan; `pendingPlan` shows what is on its way. No capacity is granted
  while a purchase is outstanding.

Nothing in the domain knows how money is collected: the provider is bound in
`src/billing/billing.module.ts` and everything Stripe-shaped (Checkout sessions,
prices, signatures, subscription cancellation) lives in
`src/billing/stripe-billing.provider.ts`. Two rules the interface exists to
enforce:

- The provider issues the purchase `reference`; the application stores it and
  hands it straight back to `confirmPurchase`. A confirmation therefore resolves
  the plan from the provider's own records, never from a request body.
- `voidPurchase` exists separately from `cancelSubscription`. A customer who
  abandons a checkout has no agreement to cancel but does have a live payment
  session, and leaving that session open means they can still be charged for a
  plan they gave up.

`BILLING_PROVIDER` selects one of two implementations:

- `stripe` — real payments. A purchase opens a Stripe Checkout session priced
  from `plans.billing_price_ref`. That column starts empty and is provisioned by
  the provider from the plan row on the first purchase, so the amount charged is
  never the amount the client asked for. The plan is applied only when
  `POST /api/v1/billing/webhook` receives a delivery whose `Stripe-Signature`
  verifies against `STRIPE_WEBHOOK_SECRET` and Stripe itself reports the session
  as paid. The route is public — its caller is Stripe, not a browser — and the
  signature is its authentication, which is why `main.ts` creates the app with
  `rawBody: true`: a signature over a re-serialised body can never match. When an
  upgrade settles, the agreement it replaces is cancelled at Stripe, so a plan
  change cannot leave a customer paying for two plans. Requires
  `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`; the app refuses to boot
  without them, because taking a payment it can never confirm is worse than not
  starting.
- `stub` — development only: settles every purchase instantly and charges
  nothing. It refuses to start when `NODE_ENV=production`, and production
  refuses to start without an explicit `BILLING_PROVIDER`, so the free-plan
  failure mode is a boot error naming the missing setting rather than a live
  billing bug.

`TRIAL_DAYS` (default 14) sets the trial length; it is read per subscription and
does not retroactively change a trial already running.

`test/billing.e2e-spec.ts` drives a deferred provider double, because the bundled
stub settles everything and would leave the central rule — a plan is never in
force before the money arrives — untested; `test/billing-webhook.e2e-spec.ts`
does the same through the signed webhook route, and
`src/billing/stripe-*.spec.ts` cover the Stripe provider and the verifier against
a stubbed Stripe client.

## Sessions

An access token is a short-lived JWT; the refresh token lives in an httpOnly
cookie. Every credential the API issues — access, refresh, email verification,
password reset and invitation — is a JWT signed with `JWT_SECRET`, and each of
the four non-access kinds carries a `purpose` claim so it cannot be replayed as
another kind (nor as a bearer token, which is what the refresh cookie would
otherwise be). The design decisions, and the failure each one prevents:

- **The refresh token is never handed to JavaScript.** `POST /auth/login` returns
  only the access token and sets `rt` alongside a readable `csrf` cookie. A token
  in `localStorage` is readable by any injected script; an httpOnly cookie is not.
- **The stored token is a SHA-256 hash**, like the password-reset token, so a copy
  of the database is not replayable against the API.
- **Every refresh rotates the token**, and rotation claims the old row with a
  conditional `UPDATE` inside a transaction rather than a read-then-write. Two
  simultaneous refreshes would otherwise both succeed and leave one family with
  two live tokens — the next refresh would then look like a replay and destroy a
  session that only ever behaved correctly. `test/session.e2e-spec.ts` fires both
  requests together and asserts exactly one wins.
- **A replayed token revokes its whole family.** A token that comes back after it
  was rotated is either an attacker or a client that raced; the two are
  indistinguishable from the token, and both get the same answer — the family
  dies and the user re-authenticates. Guessing "it's probably a race" is how a
  stolen token stays usable.
- **Expiry is absolute, not sliding** (`REFRESH_TOKEN_TTL_DAYS`, default 30). A
  sliding window never ends, so a leaked token would stay usable for as long as
  its holder kept refreshing.
- **Access tokens carry a `sid`, and it is checked on every request.** An access
  token is stateless and stays cryptographically valid until it expires; a
  database lookup is the only thing that makes logout actually log out, and a
  token with no `sid` is refused because such a token could never be revoked.
- **CSRF is double-submit.** The cookie is `SameSite=Strict`, and `refresh` and
  `logout` additionally require `x-csrf-token` to match the readable cookie, so
  a cross-site request cannot rotate or end a session.
- **Revocation is eager.** Logout, logout-all, password change and password reset
  all take effect on the next request. A password change ends *every* session
  including the one it was made with, because the point of changing a password is
  usually that somebody else has one.
- **Expired rows are swept** by `SessionCleanupService` every
  `SESSION_CLEANUP_INTERVAL_HOURS` (default 6). A revoked row is retained for a
  full token lifetime before deletion, because presenting it is what triggers
  reuse detection; deleting it early would turn a caught replay into a silent
  401 and leave the family intact.

`POST /auth/logout` is idempotent and answers `201` even with no session, so a
sign-out button needs no special casing.

## Documentation

- `docs/specification.md` — original architecture/spec (archival)
- `docs/frontend-guide.md` — frontend integration (auth, org context, errors, pagination, examples)
- `docs/openapi.json` — machine-readable contract (do not edit; regen via docs:openapi)

The OpenAPI document is the single source of API documentation and is published
incrementally, one module at a time. It currently covers `auth`, `plans`,
`subscription` and `organizations` (22 endpoints); the remaining modules are
marked `@ApiExcludeController()` and join the document as they are documented.

- `schema.sql` — archival snapshot of the original database design (see [Database](#database))

## Testing Notes

Unit specs live next to code (`*.spec.ts`). E2E in `test/*.e2e-spec.ts`. `test/openapi-artifact.e2e-spec.ts` enforces spec drift: the committed OpenAPI document must match the generated one. `OPENAPI_WRITE=1` is used by `pnpm run docs:openapi` to rewrite the committed artifact.

## Conventions

- Paths under `/api/v1`. Pagination `{ items, total, page, limit, totalPages }`. Errors use `{ statusCode, message }` plus an optional `error` name, absent on 401 and 429 (message is a string or string[]).
- Strict validation (whitelist + forbidNonWhitelisted). Dates ISO-8601; UUIDs for IDs.
- All org-scoped mutations enforce same-organization ownership and required permissions.
