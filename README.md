# BuildOps

Multi-tenant operations platform for clients, projects, teams, tasks, subtasks, work time and time-complexity estimation — with subscription limits, organization-level authorization and task badges.

**Core flow:** User → Plan → Tenant → Organization → Role/Permission → Client → Project → Team → Task → Badge (optional) → Subtask → Time Entry → Time Complexity

| | |
|---|---|
| **Stack** | NestJS 12 (ESM), TypeORM, PostgreSQL, JWT (passport-jwt), Swagger/OpenAPI |
| **Status** | MVP **step 1 of 13** complete — Authentication (see [Implementation status](#implementation-status)) |
| **Baseline spec** | [`docs/specification.md`](docs/specification.md) — original, verbatim (never lost) |
| **Database** | [`schema.sql`](schema.sql) — authoritative for migrations/DDL |
| **API docs** | Swagger UI `/api/v1/docs` · OpenAPI JSON `/api/v1/docs-json` |

> **Rule of precedence:** where the baseline spec and this README disagree, **this README
> (Corrections & decisions) is authoritative**, and for DDL, **`schema.sql` is authoritative**.
> The baseline is kept verbatim in [`docs/specification.md`](docs/specification.md) so no
> information is ever lost.

---

## Table of contents

1. [Requirements & MVP roadmap](#requirements--mvp-roadmap)
2. [Corrections & decisions](#corrections--decisions)
3. [Domain model](#domain-model)
4. [Enumerations](#enumerations)
5. [Permission catalog](#permission-catalog)
6. [Authorization model](#authorization-model)
7. [API surface (implemented)](#api-surface-implemented)
8. [Architecture & request pipeline](#architecture--request-pipeline)
9. [Database practices](#database-practices)
10. [Security](#security)
11. [Getting started](#getting-started)
12. [Testing](#testing)
13. [Implementation status](#implementation-status)

---

## Requirements & MVP roadmap

Full requirement text lives in the [baseline spec](docs/specification.md). This is the
implementation roadmap with live status.

| # | Requirement | Status |
|---|---|---|
| 1 | **Authentication** — registration, login, password security, sessions, email verification, password reset | ✅ Done |
| 2 | **Subscription foundation** — Plan definitions (`max_organizations`, `price`…), Tenant creation, plan-limit enforcement | ⬜ Pending |
| 3 | **Tenant & Organization** — subscription state, organization management, tenant isolation | ⬜ Pending |
| 4 | **Authorization** — Roles, Permissions, role assignment, server-side permission checks | ⬜ Pending |
| 5 | **Teams** — team creation and membership | ⬜ Pending |
| 6 | **CRM** — Client CRUD (email, phone, industry, website), organization-level access | ⬜ Pending |
| 7 | **Projects** — Project CRUD (`start_date`, `end_date`, `budget`), client validation, plan limits | ⬜ Pending |
| 8 | **Badges** — Badge CRUD, organization ownership, task badge assignment | ⬜ Pending |
| 9 | **Tasks / Subtasks** — team assignment, badge validation, individual assignment, status workflow | ⬜ Pending |
| 10 | **Time logging** — timer (`entry_time`/`exit_time`), manual entries, duration calculations | ⬜ Pending |
| 11 | **Time complexity** — CRUD, `min ≤ max` validation, task/subtask linkage, variance reporting | ⬜ Pending |
| 12 | **Dashboard** — project, task, time and complexity visibility | ⬜ Pending |
| 13 | **Security & E2E testing** — tenant isolation, permissions, plan limits | 🟡 Partial (auth covered) |

**Known gaps tracked against requirements (deferred, by design — step-by-step build):**

- Input validation via `class-validator` + global `ValidationPipe` (spec §17) — add with the step that introduces DTO-heavy forms (or the hardening pass in #13).
- Rate limiting on `login` / `forgot-password` (spec §17).
- Email normalization (lowercase/trim) before uniqueness check (spec §4.1).

---

## Corrections & decisions

These are the points where the implementation adds or corrects the baseline spec. Each row is
also a record so nothing is lost.

| # | Area | Baseline spec | Current (authoritative) | Why |
|---|---|---|---|---|
| 1 | **User auth fields** | §3.1 lists only `id…updated_at` | Added `is_verified`, `verification_token`, `verification_token_expires`, `reset_token`, `reset_token_expires` | Required by implemented email verification & password reset; `schema.sql` initially lacked them (dev-only `synchronize` would have masked it). |
| 2 | **Email/reset token storage** | Not specified | Raw token = 32 random bytes (hex, 64 chars) emailed to user; DB stores **SHA-256 hash** of it (`varchar(64)`). Verification TTL **24 h**, reset TTL **1 h**. | Never store raw tokens; hashed-at-rest matches spec §17 (no secrets in logs/DB). |
| 3 | **Password hashing** | "Argon2id or bcrypt" | **bcryptjs, cost factor 10** | Chosen implementation; pure-JS (no native build). Swappable to Argon2id later without schema change. |
| 4 | **TimeComplexity boundaries** | `min_time` / `max_time` as `TIMESTAMP` | Renamed to **`min_duration` / `max_duration`, type `INTERVAL`** | Spec §13 compares boundaries against a **duration** (`exit_time − entry_time`). A `TIMESTAMP` is an instant, not a duration — not comparable. `INTERVAL` compares directly and keeps `CHECK min ≤ max`. |
| 5 | **`clients.email`** | §3.10 nullable, §16 says keep email unique where applicable | `VARCHAR(255) UNIQUE` | Spec §16 requirement applied. |
| 6 | **FK indexes** | §16: add indexes to relationship fields | 23 indexes on every FK column (`idx_<table>_<column>`) | Spec §16 requirement applied. |
| 7 | **Status / priority values** | Left open ("validate allowed statuses") | **Defined below** ([Enumerations](#enumerations)) | Service-layer validation needs an explicit, single source of truth. |
| 8 | **Permission names** | §6 defers: "should be defined by the application" | **Defined below** ([Permission catalog](#permission-catalog)) | Endpoints must enforce one consistent naming scheme. |
| 9 | **Auth transport** | "secure HttpOnly cookies or short-lived access tokens" | **Bearer JWT**, `JWT_SECRET`, `JWT_EXPIRATION` (default 3600 s) | Stateless API-first choice; refresh strategy to be added later. |
| 10 | **Login status code** | — | `POST /auth/login` returns **201** (NestJS `@Post` default) | Documented in Swagger and enforced by the e2e contract test. |
| 11 | **Login requires verified email** | §4/§7 describe login for registered users; no explicit pre-verification gate | Login rejects accounts with `is_verified = false` (`403`) and re-sends a verification link. `PATCH /auth/profile` updates `name`/`email`; changing email resets verification. | Enforce email verification before access; an email change must be re-verified. |
| 12 | **Access requires verified email** | No mandate that protected routes reject unverified accounts | The JWT strategy rejects users with `is_verified = false` (`401`), and `POST /auth/register` no longer issues an access token. | No unverified account may reach protected routes. |

---

## Domain model

15 models. UUID primary keys, foreign keys, `VARCHAR` lengths and `DATE`/`TIMESTAMP`/`DECIMAL`
precision follow the baseline spec §3. **Enumerated `status`/`priority` fields are stored as
`VARCHAR(50)` and validated in the service/DTO layer** (not DB `CHECK`s) — see
[Enumerations](#enumerations).

| Model | Key fields (beyond `id`) | Scope |
|---|---|---|
| **User** | `organization_id` FK · `email` UNIQUE · `password_hash` · `name` · `status` · `is_verified` · `verification_token(_expires)` · `reset_token(_expires)` · timestamps | Auth subject |
| **Tenant** | `user_id` FK · `plan_id` FK · `status` · timestamps | Subscription owner |
| **Plan** | `name` · `description` · `max_users` · `max_projects` · `max_storage_gb` · `max_organizations` · `price DECIMAL(10,2)` | Capacity template |
| **Organization** | `tenant_id` FK · `name` · `status` · `created_at` | Tenant workspace |
| **Role** | `organization_id` FK · `user_id` FK · `name` · `description` · timestamps | Org-level access |
| **Permission** | `role_id` FK · `name` · `description` · timestamps | Capability attached to Role |
| **Badge** | `organization_id` FK · `name` · `description` · `color` · `icon` | Task classification |
| **Team** | `organization_id` FK · `name` · `description` · `status` · `created_at` | Working group |
| **TeamMember** | `team_id` FK · `user_id` FK · `role` · `status` · `joined_at` | Membership (not authz) |
| **Client** | `organization_id` FK · `name` · `email` UNIQUE · `phone` · `industry` · `website` · `status` | CRM record |
| **Project** | `organization_id` FK · `client_id` FK · `name` · `description` · `status` · `start_date` · `end_date` · `budget DECIMAL(10,2)` | Client work |
| **Task** | `project_id` FK · `team_id` FK · `badge_id` FK (nullable) · `title` · `description` · `priority` · `status` · `due_date` · timestamps | Work item |
| **Subtask** | `task_id` FK · `assigned_to` FK (must be a TeamMember of task's Team) · `title` · `description` · `status` · `due_date` · timestamps | Execution item |
| **TimeEntry** | `subtask_id` FK · `user_id` FK · `entry_time` · `exit_time` (NULL = running) · `created_at` | Work log |
| **TimeComplexity** | `task_id` FK · `subtask_id` FK · `name` · `status` · `min_duration INTERVAL` · `max_duration INTERVAL` | Estimation envelope |

**Time variance (spec §13):** actual duration = `exit_time − entry_time` (`INTERVAL`), compared
directly against `min_duration` / `max_duration`. Enforced invariant:
`CHECK (min_duration <= max_duration)`.

---

## Enumerations

Authoritative accepted values. Store as `VARCHAR(50)`; validate in DTO/service layer.

| Field | Allowed values |
|---|---|
| `User.status` | `active`, `inactive`, `suspended` |
| `Tenant.status` | `trial`, `active`, `cancelled`, `suspended` |
| `Organization.status` | `active`, `inactive`, `archived` |
| `Team.status` | `active`, `inactive`, `archived` |
| `TeamMember.status` | `pending`, `active`, `inactive`, `removed` |
| `TeamMember.role` *(team-scoped, examples)* | `lead`, `member`, `observer` |
| `Client.status` | `active`, `inactive`, `archived` |
| `Project.status` | `planned`, `active`, `on_hold`, `completed`, `cancelled` |
| `Task.priority` | `low`, `medium`, `high`, `critical` |
| `Task.status` | `todo`, `in_progress`, `in_review`, `done`, `cancelled` |
| `Subtask.status` | `todo`, `in_progress`, `done`, `cancelled` |
| `TimeComplexity.name` | `low`, `medium`, `high`, `critical` |
| `TimeComplexity.status` | `active`, `archived` |

Notes:
- `User.status` is account lifecycle; **email verification is tracked separately by `is_verified`**.
- Billing-specific values (e.g. `past_due`) are intentionally omitted — billing arrives later (spec §19).
- `TeamMember.role` is **team-scoped only** — organization access comes from `Role`/`Permission` (spec §5).

---

## Permission catalog

Naming scheme: **`resource.action`** (lowercase), stored in `permissions.name`, enforced
**server-side** on every protected operation.

| Resource | Permissions |
|---|---|
| `organization` | `view`, `create`, `update`, `delete` |
| `member` | `view`, `invite`, `update`, `remove` |
| `role` | `view`, `create`, `update`, `delete`, `assign` |
| `permission` | `view` |
| `team` | `view`, `create`, `update`, `delete`, `member.add`, `member.remove` |
| `client` | `view`, `create`, `update`, `delete` |
| `project` | `view`, `create`, `update`, `delete` |
| `badge` | `view`, `create`, `update`, `delete` |
| `task` | `view`, `create`, `update`, `delete` |
| `subtask` | `view`, `create`, `update`, `delete`, `assign` |
| `time_entry` | `view`, `view_all`, `create`, `update`, `delete`, `start_timer`, `stop_timer` |
| `time_complexity` | `view`, `create`, `update`, `delete` |
| `dashboard` | `view` |

**Suggested default role templates** (seed data, step 4):

| Role | Grants (summary) |
|---|---|
| **Owner** | All permissions (tenant creator). |
| **Project Manager** | All `view`; full `client`, `project`, `badge`, `task`, `subtask`, `time_complexity`; `team` + `member` + `role`/`permission` view & manage; `time_entry.view_all`; `dashboard.view`. |
| **Developer** | `task` view/create/update, `subtask` view/create/update/assign, `time_entry` (own) + timers, read access to `team`/`client`/`project`/`badge`, `dashboard.view`. |
| **Tester** | `task` view/update, `subtask` view/create/update, `time_entry` (own) + timers, read access to `team`/`project`/`badge`, `dashboard.view`. |
| **Viewer** | Every `*.view` + `dashboard.view`. |

`time_entry.view` covers **the caller's own** entries; org/team-wide time requires
`time_entry.view_all` **plus** the ownership check (spec §5: *Permission Check → Ownership Check*).

---

## Authorization model

1. Authentication identifies the User (JWT).
2. Authorization runs **within the active Organization context** on the backend.
3. Flow: `Request → Auth middleware → Tenant context → Organization context → Resolve Role/Permissions → Resource ownership check → Business service → Database`.
4. `TeamMember.role` is **never** the source of organization-level access (spec §5).

Full text: [baseline spec §5–§6](docs/specification.md).

---

## API surface (implemented)

All endpoints are Swagger-documented and contract-tested (`test/swagger.e2e-spec.ts`).

| Method | Path | Auth | Success | Errors | Notes |
|---|---|---|---|---|---|
| `POST` | `/auth/register` | — | `201` `{message, user}` | `409` email taken | Hashes password, creates user, emails verification link. No token until the email is verified. |
| `POST` | `/auth/login` | — | `201` `{access_token}` | `401` bad credentials · `403` email not verified | Requires `is_verified`. Unverified accounts are rejected and a fresh verification link is sent. |
| `GET` | `/auth/verify-email?token=` | — | `200` message | `400` invalid/expired | Idempotent ("already verified" message). |
| `POST` | `/auth/forgot-password` | — | `201` message | — | Always same generic message (no account enumeration). |
| `POST` | `/auth/reset-password` | — | `201` message | `400` invalid/expired | Consumes token, clears it on success. |
| `GET` | `/auth/profile` | Bearer JWT | `200` user | `401` no/invalid token · `401` unverified | Returns safe user (never `password_hash`/tokens). Verified accounts only. |
| `PATCH` | `/auth/profile` | Bearer JWT | `200` user | `401` no/invalid token · `409` email taken | Updates `name`/`email`. Changing email resets verification and re-sends the link. Verified accounts only. |

`user` responses always omit `password_hash`, `verification_token`, `reset_token` and their
expiry columns.

---

## Architecture & request pipeline

Standard pattern for **every** module (spec §15):

```
Request → Authentication → Tenant/Organization context → Plan check (when applicable)
        → Permission check → Relationship validation → Business service → Database → Response
```

Controllers stay thin; business rules, tenant isolation, plan limits and relationship validation
live in the service layer.

---

## Database practices

Applied in [`schema.sql`](schema.sql):

- UUID primary keys; foreign keys with explicit `ON DELETE` behavior.
- `email` unique: `users.email` **and** `clients.email`.
- 23 FK indexes (`organization_id`, `tenant_id`, `project_id`, `task_id`, `subtask_id`,
  `team_id`, `role_id`, `user_id`, `badge_id`, …).
- `CHECK (min_duration <= max_duration)` on `time_complexity`.
- Field types preserved per baseline §3 (`DECIMAL(10,2)` budget, `DATE` vs `TIMESTAMP`, lengths).
- Service-layer relationship validation **even when FKs exist** (e.g. Subtask assignee must be a
  TeamMember of the Task's Team).
- Pagination for client/project/task/time-entry lists (when those modules land).
- Plan limits centralized for consistent enforcement.

---

## Security

| Requirement (spec §17) | Implementation |
|---|---|
| Passwords hashed, never plaintext | bcryptjs, cost 10 (`src/user/user.entity.ts`) |
| Tokens never stored raw | Email tokens stored as SHA-256 hashes |
| Session/transport | Bearer JWT (`JWT_SECRET`, `JWT_EXPIRATION`) |
| Authorization | Server-side JWT guard; org/tenant checks per step 4+ |
| Input validation | ⬜ Pending — `class-validator` + global `ValidationPipe` |
| Rate limiting | ⬜ Pending — protect `login`, `forgot-password` |
| Secrets outside source | `.env` git-ignored (`.env.example` should be committed) |
| Transport | HTTPS outside local dev (deployment concern) |
| Data isolation | No client-provided ID may bypass tenant/org ownership checks |
| Logging | Mail/auth logs contain no passwords or raw tokens |

---

## Getting started

```bash
# 1. Install
npm install

# 2. Configure environment
cp .env.example .env   # then edit values
```

Environment variables (names only — values stay in `.env`, never committed):

| Variable | Purpose |
|---|---|
| `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE` | PostgreSQL connection |
| `JWT_SECRET`, `JWT_EXPIRATION` | Access-token signing (seconds, default `3600`) |
| `EMAIL_FROM`, `APP_BASE_URL` | Outgoing mail "from" + link base URL |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` | SMTP transport |
| `RESEND_API_KEY` | Resend (optional alternate transport) |

```bash
# 3. Create the database schema
psql "$DATABASE_URL" -f schema.sql

# 4. Run
npm run start:dev      # development (watch)
npm run build          # compile
npm run start:prod     # production → node dist/main
npm run lint           # oxlint
```

Swagger UI: `http://localhost:3000/api/v1/docs` · OpenAPI JSON: `http://localhost:3000/api/v1/docs-json`

**Every endpoint is served under the `/api/v1` prefix.** A frontend should set its base URL once
(`http://localhost:3000/api/v1`) and then call paths relative to it, e.g. `/auth/login`,
`/dashboard/overview`. The tables below list paths without the prefix for readability.

> In non-production, TypeORM `synchronize` is enabled as a convenience. **`schema.sql` remains
> the source of truth for production migrations.**

---

## Testing

```bash
npm test           # unit  — Jest
npm run test:e2e   # e2e   — supertest + OpenAPI contract
npm run test:cov   # coverage
```

Current: **45 unit tests**, **24 e2e tests** — all passing.

- `test/swagger.e2e-spec.ts` — boots the app with mocked services, asserts `/api/v1/docs-json` documents
  every endpoint with the **exact** status codes and DTO schemas, then exercises each endpoint
  against the real implementation.
- `test/app.e2e-spec.ts` — root route smoke test (needs reachable PostgreSQL).

---

## Implementation status

**Step 1 — Authentication ✅** (complete)

- `src/auth/` — controller, service, JWT strategy/guard, DTOs (Swagger-documented)
- `src/user/` — entity (incl. verification/reset fields), service
- `src/mail/` — SMTP transport, verification & reset templates
- Access gated on `is_verified`: register issues no token, login rejects unverified (`403` + fresh link), JWT strategy rejects unverified accounts (`401`); `PATCH /auth/profile` updates `name`/`email` (email change re-verifies)
- Verified: `npm run lint` clean · `npm run build` clean · 45 unit + 24 e2e green
- Known deferred items: input validation, rate limiting, email normalization (see
  [Requirements](#requirements--mvp-roadmap))

**Next up → Step 2 — Subscription foundation:** `Plan` + `Tenant` models, subscription state,
plan-limit enforcement (`max_users`, `max_projects`, `max_organizations`, `max_storage_gb`).

**Then → Step 3 — Tenant & Organization**, followed by **Step 4 — Authorization** (Roles,
Permissions, the [permission catalog](#permission-catalog) above).

Implementation proceeds **step by step**; each step updates this file, `schema.sql` and the
[baseline](docs/specification.md)-to-current delta in [Corrections](#corrections--decisions).

---

### Document map

| File | Role |
|---|---|
| `README.md` | **This document** — authoritative current requirements, decisions, status. |
| `docs/specification.md` | Original baseline spec, verbatim — never edited, never lost. |
| `schema.sql` | Authoritative DDL (tables, FKs, indexes, constraints). |
| `PLAN.md` | Historical work log for completed tasks (Swagger documentation pass). |
