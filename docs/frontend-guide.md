# OPS API — Frontend Integration Guide

Audience: frontend engineers building a client against this NestJS backend.

This guide covers the contract you cannot infer from the endpoint list: how auth
works, how the active organization is selected, what the error bodies look like,
and which call fails in which way. Per-field request/response schemas live in the
generated OpenAPI document (see [Live spec](#1-live-spec)).

---

## 1. Live spec

| What                     | URL                                      |
| ------------------------ | ---------------------------------------- |
| Base URL (local)         | `http://localhost:3000/api/v1`           |
| Swagger UI               | `http://localhost:3000/api/v1/docs`      |
| OpenAPI JSON (live)      | `http://localhost:3000/api/v1/docs-json` |
| OpenAPI JSON (committed) | `docs/openapi.json`                      |
| Liveness probe           | `GET /api/v1/` → `Hello World!`          |

Every route below lives under the global prefix `api/v1` — include it in your
`baseURL` so you never hard-code it in a path. `PORT` overrides `3000`.

The document is published **one module at a time**. It currently covers **119
endpoints** in 16 tag groups — `auth`, `plans`, `subscription`, `organizations`,
`roles`, `invitations`, `teams`, `clients`, `projects`, `badges`, `tasks`,
`subtasks`, `time-entries`, `time-complexity`, `dashboard` and `settings` — from
`POST /auth/register` through the invitation flow. The liveness probe is the
only controller still hidden with `@ApiExcludeController()`; a route that is
missing from the document is not published yet. Where the document and this
guide disagree, treat the Swagger document as the authority on shape and this
guide as the authority on behaviour.

Do not hand-maintain a client from this document: generate types from
`docs/openapi.json` (openapi-typescript, Orval, `swagger-typescript-api`) and use
the tables here for behaviour that the schema cannot express. The committed file is
a byte-for-byte copy of what the server serves at `docs-json`, so type generation
works offline and in CI without starting the API.

### Keeping the spec in sync

`docs/openapi.json` is generated from the decorators on the controllers and DTOs,
and is not edited by hand:

```
npm run docs:openapi     # rewrites docs/openapi.json
npm run test:e2e         # fails if the committed file is stale
```

Point your type generator at it: `openapi-typescript docs/openapi.json`.

`test/openapi-artifact.e2e-spec.ts` regenerates the document in memory and
compares it with the committed file, so a new endpoint, a changed DTO or a
missing `@ApiResponse` that is not followed by `npm run docs:openapi` fails the
e2e run. It also asserts the document is complete (3.x, a server URL carrying the
prefix, a description for every tag, an `operationId`/`summary`/`description` on
every operation) and that the access-control extensions agree with the bearer
scheme. `test/openapi.e2e-spec.ts` covers the rest — the exhaustive route table of
the published modules, success codes, the bearer scheme and `$ref` integrity.

When a module joins the document, the same commit drops its
`@ApiExcludeController()`, adds its tag description to `TAGS` in
`src/swagger.setup.ts`, and adds its routes to `DOCUMENTED_OPERATIONS` in
`test/openapi.e2e-spec.ts`.

Access control is published twice from one source, so it cannot drift:
`security` (the standard field) and `x-auth` / `x-organization-context` /
`x-permissions`, written by the same decorators the guards read.

---

## 2. Browser rules (CORS, credentials, headers)

| Aspect           | Behaviour                                                                                                                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Allowed origins  | **Any origin** in development, and the server logs `[bootstrap] CORS: allowing all origins…` at boot. Set `ALLOWED_ORIGINS=https://app.example.com` (comma-separated) to lock it down. **`NODE_ENV=production` refuses to start without it**, and `ALLOWED_ORIGINS=*` is rejected in production.                  |
| Credentials      | `credentials: 'include'` — **required**. The refresh token lives in an httpOnly cookie, so without it every session dies the moment the access token expires.                                                                                                                   |
| Allowed headers  | `Content-Type`, `Authorization`, `x-organization-id`, `x-csrf-token`. The custom headers are allow-listed explicitly because browsers preflight any request carrying them and reject the call when one is missing from `Access-Control-Allow-Headers`.       |
| Methods          | `GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS`                                                                                                                                                                                                      |
| Security headers | `helmet()` is applied to every response. Do not be surprised by `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN` and a `default-src 'self'` CSP on API responses. They do not affect JSON consumption. |

`x-organization-id` is **not** a CORS-safelisted header, so every call that carries
it triggers a preflight `OPTIONS`. Verify once, at integration time, that your
browser accepts it — `curl` will not reproduce preflight problems because it
sends no `Origin`:

```
OPTIONS /api/v1/clients
Origin: http://localhost:5173
Access-Control-Request-Method: GET
Access-Control-Request-Headers: authorization,content-type,x-organization-id

→ 204
  Access-Control-Allow-Headers: Content-Type,Authorization,x-organization-id
```

If `x-organization-id` is absent from that response, the browser blocks every
organization-scoped call; the allow-list lives in `src/bootstrap.ts` and is
covered by `test/cors.e2e-spec.ts`.

The access token is sent in the `Authorization` header. The refresh token is
**not**: it is an httpOnly cookie the browser attaches on its own, which is what
stops a cross-site script from reading it. That is also why `credentials:
'include'` is not optional, and why the two refresh-affecting routes require an
`x-csrf-token` header (see §3).

Recommended client shape:

```ts
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL,
  // Not optional: the refresh token is a cookie, and without this it is never
  // sent and the session ends at access-token expiry.
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  const token = tokenStore.get();
  if (token) config.headers.Authorization = `Bearer ${token}`;

  const organizationId = orgStore.get();
  if (organizationId) config.headers['x-organization-id'] = organizationId;

  return config;
});
```

---

## 3. Authentication

A short-lived bearer JWT paired with a rotating refresh token in an httpOnly
cookie. The access token goes in the `Authorization` header; the refresh token
never enters JavaScript at all.

| Property   | Value                                                                                   |
| ---------- | --------------------------------------------------------------------------------------- |
| Header     | `Authorization: Bearer <access_token>`                                                  |
| Payload    | `{ sub: <userId>, email, sid }`                                                        |
| Expiry     | `JWT_EXPIRATION` seconds, default `3600` (1 h)                                          |
| Revocation | Changing the email resets `isVerified`, which invalidates the token on the next request |

Every authenticated request re-reads the user from the database and requires
`isVerified === true`. A token for a user who later becomes unverified fails with
`401`, not `403`.

### 3.1 Sign-up → verify → sign-in

```http
POST /api/v1/auth/register
Content-Type: application/json

{ "email": "dev@example.com", "password": "Someone123!", "name": "Dana" }
```

`201`:

```json
{
  "message": "Registration successful. Please verify your email before logging in.",
  "user": {
    "id": "9a2b…",
    "organizationId": null,
    "email": "dev@example.com",
    "name": "Dana",
    "status": "active",
    "isVerified": false,
    "createdAt": "2026-09-18T11:11:22.041Z",
    "updatedAt": "2026-09-18T11:11:22.041Z"
  }
}
```

- **No token is issued here.** Registration alone cannot sign the user in.
- `409` when the email is already registered. Compare emails case-insensitively —
  the server lowercases and trims before the uniqueness check, so
  `Dev@Example.com` collides with `dev@example.com`.
- Email delivery failures never fail the request: the user is created and the
  send is fire-and-forget. If the backend has no working SMTP configuration, a
  `201` still comes back but no mail arrives.

Verification is a `GET` with the raw token in the query string:

```http
GET /api/v1/auth/verify-email?token=<raw token>
```

`200` → `{ "message": "Email verified successfully" }`, or
`{ "message": "Email already verified" }` if the link is clicked twice.
`400` → `Invalid or expired verification token` (tokens expire after 24 h).

Then:

```http
POST /api/v1/auth/login
{ "email": "dev@example.com", "password": "Someone123!" }
```

`201` → `{ "access_token": "<jwt>" }` — note the **snake_case** key — plus two
`Set-Cookie` headers:

| Cookie  | HttpOnly | Purpose                                                                             |
| ------- | -------- | ----------------------------------------------------------------------------------- |
| `rt`    | yes      | The refresh token. Never readable from JavaScript.                                 |
| `csrf`  | no       | Echoed back as `x-csrf-token` on `refresh` and `logout` (§3.6).                     |

Both are `SameSite=Strict`, `Secure` in production, and scoped to
`Path=/api/v1/auth` so they are not attached to any other request.

- `401 Invalid credentials` for unknown email _and_ wrong password (identical on
  purpose, do not distinguish them in the UI).
- `403 Email not verified. Check your inbox…` — the server re-sends a fresh
  verification link on every unverified login attempt, so a "resend" button can
  simply call `login` again.

### 3.2 Password rules

Enforced identically on register, reset and profile password change:

- 8–128 characters
- at least one letter and at least one digit (`/^(?=.*[A-Za-z])(?=.*\d).{8,128}$/`)

Validate client-side with the same rule to avoid a round trip:

```ts
const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{8,128}$/;
```

### 3.3 Password reset

```http
POST /api/v1/auth/forgot-password
{ "email": "dev@example.com" }
```

Always `201` with `If an account with that email exists, a reset link was sent`,
whether or not the account exists — never reveal existence in the UI.

```http
POST /api/v1/auth/reset-password
{ "token": "<raw token>", "password": "NewPass123!" }
```

`201` → `{ "message": "Password reset successfully" }`. `400` on invalid/expired
token (1 h TTL). The token is consumed by resetting the password.

To check a token without consuming it — for instance when the user opens the
emailed link — use `GET /api/v1/auth/reset-password?token=…`: `200` while the
token is live, `400` once it is invalid or expired (§4).

### 3.4 Profile

| Method  | Path            | Notes                                                                           |
| ------- | --------------- | ------------------------------------------------------------------------------- |
| `GET`   | `/auth/profile` | The call to use to rehydrate a session on page load. Returns `UserResponseDto`. |
| `PATCH` | `/auth/profile` | All fields optional.                                                            |

`PATCH /auth/profile` accepts:

| Field             | Type                     | Effect                                                                                                                                   |
| ----------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `name`            | `string` (1–255)         | Display name                                                                                                                             |
| `email`           | `string`                 | **Resets verification** and re-sends the link; the current token stops working (`401`)                                                   |
| `status`          | `'active' \| 'inactive'` | Only these two values are accepted here (a third value, `suspended`, exists in the data model but is not settable through this endpoint) |
| `password`        | `string`                 | New password, same rules                                                                                                                 |
| `currentPassword` | `string`                 | **Required** whenever `password` is sent, otherwise `400`                                                                                |

Sending no changed field returns the current profile unchanged.

### 3.5 Keeping the session alive

`GET /auth/profile` is the call to rehydrate a session on page load. Send the
access token in the header, with `credentials: 'include'` so the cookie travels.

When a call returns `401`, the access token has expired and the session may still
be alive. Refresh once, then retry:

```ts
let refreshing: Promise<void> | null = null;

// A single in-flight refresh, shared by every request that raced into a 401.
// Without this, ten parallel calls on a stale token would fire ten refreshes;
// the server correctly treats a second use of a rotated token as a replay and
// kills the session, so the "fix" would end the user's session instead of
// extending it.
export const refreshOnce = () => {
  refreshing ??= (async () => {
    const res = await fetch(`${import.meta.env.VITE_API_URL}/api/v1/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'x-csrf-token': readCookie('csrf') },
    });
    if (!res.ok) throw new Error('session ended');
    tokenStore.set((await res.json()).access_token);
  })().finally(() => {
    refreshing = null;
  });

  return refreshing;
};
```

`refresh` returns a **new** access token and rotates the refresh cookie, so always
take the returned token rather than reusing the one you already had.

### 3.6 CSRF

`POST /auth/refresh` and `POST /auth/logout` require an `x-csrf-token` header
whose value matches the readable `csrf` cookie. This is a double-submit check:
without it, any site could make the browser send the `rt` cookie cross-origin
and silently rotate or end the session. (`logout` skips the check when there is
no `csrf` cookie at all, so it stays usable after the cookie has been cleared.)

Send the header on those two calls; every other route ignores it.

### 3.7 Sessions, logout, and "log out everywhere"

| Call                     | Auth                | Effect                                                          |
| ------------------------ | ------------------- | --------------------------------------------------------------- |
| `GET /auth/sessions`     | Bearer              | One entry per device: `{ id, userAgent, ip, createdAt, expiresAt, isCurrent }` |
| `POST /auth/logout`      | `rt` + `csrf`       | Ends **this** session and clears both cookies. Always succeeds.  |
| `POST /auth/logout-all`  | Bearer              | Ends **every** session for the account.                          |

`id` is the session family, so it stays stable across refreshes — that is the
value to pass to whatever "sign out this device" affordance you build.

Three rules that will save you a support ticket:

1. **`logout` is idempotent and needs no bearer token.** It answers `201` even
   with no session at all, so a "sign out" button can call it unconditionally.
2. **Rotation is strict.** Presenting an already-rotated refresh token revokes
   the entire session — the server cannot distinguish a stolen token from a
   double refresh, so it assumes the worst. See `refreshOnce` in §3.5.
3. **A revoked session kills its access tokens immediately**, not at expiry.
   Logout, logout-all, a password change and a password reset all take effect on
   the very next request, which is why you can rely on a `401` after logging out
   rather than waiting out the token.

Changing the password or resetting it ends every session, including the one the
change was made with — the `PATCH`/`POST` still returns its normal success
response.

### 3.8 Account

Everything a person can do to their own account, in one area, for the settings
screen. All of it authenticates on the access token alone: **no
`x-organization-id`, no permission**, and a user who belongs to no organization
can use every route here.

| Method   | Path                                        | Body / query                    | Success                 | Errors                          |
| -------- | ------------------------------------------- | ------------------------------- | ----------------------- | ------------------------------- |
| `GET`    | `/settings/account`                         | —                               | `200 AccountResponseDto`| `401`                           |
| `PATCH`  | `/settings/account/password`                | `{ currentPassword, newPassword }` | `200 AccountResponseDto` | `400`, `401`                  |
| `PATCH`  | `/settings/account/email`                   | `{ email }`                     | `200 AccountResponseDto` | `400`, `401`, `409`            |
| `GET`    | `/settings/account/sessions`                | —                               | `200 SessionResponseDto[]` | `401`                         |
| `DELETE` | `/settings/account/sessions/{sessionId}`    | —                               | `200 { message }`       | `400`, `401`, `404`             |
| `DELETE` | `/settings/account`                         | `?confirm=<email>` `{ password }` | `200 { message }`     | `400`, `401`, `409`             |

`AccountResponseDto` is `{ id, email, name, status, isVerified, activeSessions,
createdAt, updatedAt }`. One call renders the whole tab: `activeSessions` is the
same count `sessions` would list, so the summary needs no second request.

**Why these exist next to `PATCH /auth/profile`.** `/auth/profile` can change
everything at once, which is convenient for a form that has all of it and is also
how a client sends `password` without `currentPassword` and gets a `400`. These
routes are one thing at a time, and the required fields cannot be forgotten.

Three behaviours to code around:

1. **A password change signs the user out everywhere, including the tab that made
   it.** The `200` still arrives, reporting `activeSessions: 0`; the token in hand
   is refused from the next request. Send the user back through `POST /auth/login`
   with the new password rather than treating the `200` as "done, keep going".
2. **An email change resets verification, so the current token stops working
   immediately** (`isVerified` is `false`, and an unverified account cannot mint
   tokens). The response says so; show "check your new inbox" and expect to be
   signed out until the link is followed.
3. **Session ids are session families**, stable across refreshes, which is the
   value to send to `DELETE …/sessions/{sessionId}`. An id that is unknown,
   expired or somebody else's is the same `404`, so a revoke button that fires
   twice shows nothing to worry about.

**Account deletion takes two independent proofs**: `password` (which a leaked
access token cannot produce) and `?confirm=<email>`. The first attempt without the
confirmation answers `409` and repeats the address to type, so the flow is:

```ts
const res = await deleteAccount(password);              // 409 + the address
await deleteAccount(password, res.message);             // with ?confirm=<email>
```

What it does: every session ends, preferences are dropped, the account's role
assignments are released (freeing its seat against the plan's `max_users`) and its
team memberships are removed. What it deliberately leaves: the workspace, its
organizations and everything logged under the account. Those keep pointing at the
user id, which no longer names anybody. The address is freed for a new
registration and the row is anonymised, so this cannot be undone — there is no
restore, unlike the content deletes in §8.4.

---

## 4. Email deep links

Every email contains a link built from `APP_BASE_URL` (default
`http://localhost:3000`, i.e. **the API host**):

| Email                    | Link                                                |
| ------------------------ | --------------------------------------------------- |
| Verify your email        | `{APP_BASE_URL}/api/v1/auth/verify-email?token=…`   |
| Reset your password      | `{APP_BASE_URL}/api/v1/auth/reset-password?token=…` |
| You have been invited    | `{APP_BASE_URL}/api/v1/invitations/accept?token=…`  |

Consequences for the frontend:

1. **The verification link points at the API, not at your app.** Following it
   shows raw JSON, not a branded page. If you want a real screen, either ask the
   backend to set `APP_BASE_URL` to your frontend origin and own a
   `/verify-email?token=…` route that calls the endpoint, or keep the current
   behaviour and link users to your app from the email template.
2. **The reset link is a `GET` URL; resetting is a `POST`.** Opening the
   emailed URL answers `200 { message }` while the token is still usable and
   `400` once it is invalid or expired — it validates, it never resets
   anything. Own a `/reset-password?token=…` page, read the token from the
   query string, and submit it as `POST /auth/reset-password` with the new
   password.
3. **The invitation link follows the same split, in the other order.** `GET
   /invitations/accept?token=…` is the preview the landing page should call to
   show who invited whom, under which role, and whether the address already has
   an account; `POST /invitations/accept` is what actually creates the
   membership. Own an `/invitations/accept?token=…` route, keep the token out of
   analytics, and be ready for `409` when the link has already been used.
4. Tokens are opaque 32-byte hex strings, valid once, and stored hashed. They
   arrive in the query string — strip them from client-side analytics and logs.
5. **Outside production** the API returns the same links in JSON as well:
   `POST /auth/register` answers with `verificationToken` + `verificationLink`,
   `POST /auth/forgot-password` with `resetToken` + `resetLink` (only for an
   existing account, so the unknown-email answer stays identical), the `403` of
   an unverified login carries the fresh `verificationToken` too, and
   `POST /organizations/{organizationId}/invitations` with `invitationToken` +
   `invitationLink`. Each of those responses also carries `emailSent` and, when
   the send failed, `emailError`. Production responses never contain a token:
   there it exists only in the email.

---

## 5. Organization context

Almost every business endpoint is scoped to one organization. The API resolves
the active organization in this order:

1. the `:organizationId` **path parameter**, when the route has one;
2. otherwise the **`x-organization-id` request header**.

Resolution rules and their failure modes (`src/common/guards/permissions.guard.ts`):

| Situation                                            | Result                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Header or path param present, caller is a member     | Proceed; membership decides the effective permissions                                                                          |
| Neither header nor path param on an org-scoped route | **`404`** `Organization context is required: send the x-organization-id header or use an /organizations/:organizationId route` |
| Organization exists but the caller is not a member   | **`403`** `You do not have access to this organization`                                                                        |
| Member lacks a required permission                   | **`403`** `Missing required permission: <comma-separated list>`                                                                |
| A non-UUID in the path param or header               | **`400`** `Validation failed (uuid is expected)`                                                                               |

Membership is checked before the record lookup, so a route scoped by path
parameter answers **`403`** for an unknown, deleted or foreign organization
rather than `404`. There is no way to tell those three apart from outside, which
is the intent. The `404` for a missing context therefore appears only on routes
that take the header instead of a path segment.

The missing-context case deliberately returns `404`, not `400`. Treat a `404`
whose body mentions `x-organization-id` as "no organization selected in the UI",
not as "record not found".

The header is **not** a grant of access — a client-supplied id is always checked
against the caller's role assignments, so you cannot escalate by editing it.

Routes that need **no** organization context:

- `POST /auth/register`, `POST /auth/login`, `GET /auth/verify-email`,
  `POST /auth/forgot-password`, `POST /auth/reset-password` (public)
- `GET /auth/profile`, `PATCH /auth/profile`
- all `/subscription*` routes
- `GET /organizations`, `POST /organizations`

Routes that read `:organizationId` from the path (header optional, path wins):

- `/organizations/{organizationId}` and everything under it (`/roles`, `/members`,
  `/role-templates`)

### 5.1 Frontend organization switcher

1. `GET /organizations` → the caller's organizations (paginated).
2. Store the selection, send it as `x-organization-id` on every org-scoped call.
3. Remember it across reloads; the API has no "current organization" concept, so
   the selection lives entirely in your client.
4. On `403 You do not have access to this organization`, drop the selection and
   prompt for another one.

---

## 6. Permissions and UI gating

Every permission is a dotted string (`task.create`). `GET
/organizations/{organizationId}/role-templates` returns the five built-in
templates as an array of `{ key, name, description, permissions[] }`. The `owner`
template carries every permission in the system, so the union of the templates'
`permissions` arrays is the complete catalogue — the right source for building a
permission picker or validating a custom role.

| Template          | Who it is for                                                                           |
| ----------------- | --------------------------------------------------------------------------------------- |
| `owner`           | Tenant creator. Every permission in the system.                                         |
| `project_manager` | Runs delivery: clients, projects, teams, tasks, subtasks, estimation, all time entries. |
| `developer`       | Creates/updates development tasks and subtasks, logs **own** time.                      |
| `tester`          | Reviews work, manages test subtasks, logs **own** time.                                 |
| `viewer`          | Read-only across every resource.                                                        |

Five built-in roles per organization, one role per member. To gate UI, either
(a) fetch `GET /organizations/{organizationId}/members` and match the signed-in
user's `userId` to read their `permissions` array, or (b) derive it from the
known template. Option (a) survives custom roles created through the API.

The API is the only enforcement point: hiding a button is UX, not security. Every
`403 Missing required permission` is a legitimate response to a stale UI.

<details>
<summary>Full permission catalogue</summary>

`organization.view`, `organization.create`, `organization.update`,
`organization.delete`, `member.view`, `member.invite`, `member.update`,
`member.remove`, `role.view`, `role.create`, `role.update`, `role.delete`,
`role.assign`, `permission.view`, `team.view`, `team.create`, `team.update`,
`team.delete`, `team.member.add`, `team.member.remove`, `client.view`,
`client.create`, `client.update`, `client.delete`, `project.view`,
`project.create`, `project.update`, `project.delete`, `badge.view`,
`badge.create`, `badge.update`, `badge.delete`, `task.view`, `task.create`,
`task.update`, `task.delete`, `subtask.view`, `subtask.create`,
`subtask.update`, `subtask.delete`, `subtask.assign`, `time_entry.view`,
`time_entry.view_all`, `time_entry.create`, `time_entry.update`,
`time_entry.delete`, `time_entry.start_timer`, `time_entry.stop_timer`,
`time_complexity.view`, `time_complexity.create`, `time_complexity.update`,
`time_complexity.delete`, `dashboard.view`

</details>

---

## 7. Onboarding: plan → subscription → organization → members

Registration creates a **user**, not a workspace. The tenant subscription and its
first organization are separate steps, and capacity is plan-limited.

```
POST /auth/register  →  GET /auth/verify-email?token=…  →  POST /auth/login
      ↓
GET  /plans                                   (public catalogue)
POST /subscription   { planId, status? }       (creates or reactivates the subscription)
      ↓
POST /organizations  { name, status? }        (creator receives the Owner role)
      ↓
POST /organizations/{organizationId}/members      { userId | email, templateKey }
  — or, when the address has no account yet —
POST /organizations/{organizationId}/invitations  { email, templateKey? }
      ↓ the invitee opens the emailed /api/v1/invitations/accept?token=…
POST /invitations/accept  { token, name?, password? }   (creates the account and the role)
```

`POST /members` and `POST /invitations` are two doors into the same room: the
first grants access to an account that already exists (and `404`s when the email
has none), the second emails a link and creates the role only when somebody
clicks it — no plan seat is claimed for an invitation nobody has accepted. Only
one of them can be pending per address: a second invitation for an address that
is already invited is `409` until the first is revoked (`DELETE
/organizations/{organizationId}/invitations/{invitationId}`), and an invitation
for somebody who is already a member is `409` as well — with a message that
names `…/members/{userId}/activate` when that membership is merely suspended.

`GET /plans` is public and returns three seeded plans ordered by price:

| Plan     | Price  | Users | Projects | Storage | Organizations |
| -------- | ------ | ----- | -------- | ------- | ------------- |
| Starter  | 19.00  | 5     | 3        | 5 GB    | 1             |
| Growth   | 79.00  | 25    | 25       | 50 GB   | 3             |
| Business | 299.00 | 100   | 200      | 500 GB  | 10            |

Before showing a plan picker, call `GET /subscription`. A `404 No subscription
found. Subscribe to a plan first.` means the user is new; a `200` means a
subscription already exists and the screen should be a plan _change_, not a
subscribe form (`POST /subscription` on an active subscription with a different
plan returns `409` and tells you to use `PATCH /subscription/plan`).

Plan limits are enforced server-side on every capacity-consuming create, and both
cases are `400` with a human-readable message:

- `Plan limit reached: the Starter plan allows 3 projects, 3 in use.`
- `Subscription is cancelled. Reactivate it before using the workspace.` — after
  `DELETE /subscription`. Data is preserved; re-`POST /subscription` to reactivate.

`GET /subscription/usage`, and the `usage` array that `GET /subscription` and
`POST /subscription` embed in their response, are the right input for a usage
meter. `PATCH /subscription/plan` returns only `{ message }`, so re-fetch
`GET /subscription` after a plan change:

```json
[
  { "resource": "organizations", "used": 1, "limit": 3, "remaining": 2 },
  { "resource": "users", "used": 4, "limit": 25, "remaining": 21 },
  { "resource": "projects", "used": 0, "limit": 25, "remaining": 25 }
]
```

`resource` is always one of `organizations`, `users`, `projects`.

---

## 8. Shared conventions

### 8.1 Pagination envelope

Every list endpoint that takes `?page=&limit=` returns the same shape:

```json
{
  "items": [/* … */],
  "total": 42,
  "page": 1,
  "limit": 20,
  "totalPages": 3
}
```

| Param   | Default | Rules                             |
| ------- | ------- | --------------------------------- |
| `page`  | `1`     | 1-based integer, `min 1`          |
| `limit` | `20`    | integer `1…100`; `101` is a `400` |

Lists are ordered newest/most relevant first (time entries by `entryTime desc`).
`GET /organizations` is paginated too. `GET /dashboard/projects`,
`/dashboard/clients` and `/dashboard/overdue` are **not** — they return
`{ total, items }` only.

### 8.2 Error envelope

```json
{
  "statusCode": 400,
  "message": "Validation failed",
  "error": "Bad Request"
}
```

Always `statusCode` and `message`. There is no `timestamp` and no `path`.

**`error` is optional.** Nest includes it only when the exception was thrown
with a message, so it is missing on the two errors you will hit most:

```json
{ "statusCode": 401, "message": "Unauthorized" }
```

```json
{ "statusCode": 429, "message": "ThrottlerException: Too Many Requests" }
```

Never read `error` without a guard — branch on `statusCode` instead. Where it is
present it is the status name: `Bad Request`, `Unauthorized`, `Forbidden`,
`Not Found`, `Conflict` or `Too Many Requests`.

A validation failure returns `message` as an array:

```json
{
  "statusCode": 400,
  "message": [
    "email must be an email",
    "password must be longer than or equal to 8 characters"
  ],
  "error": "Bad Request"
}
```

`message` is a **string** for business errors and a **string array** for
validation failures, so always normalise before rendering:

```ts
const text = Array.isArray(err.message) ? err.message.join('\n') : err.message;
```

| Status | Meaning in this API                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `400`  | Validation failed; bad UUID in the path; business rule violation (plan limit, cancelled subscription, wrong `currentPassword`) |
| `401`  | Missing, malformed, expired token — or the user's email is no longer verified                                                  |
| `403`  | Authenticated but not a member of the organization, or missing a required permission                                           |
| `404`  | Record not found, or missing organization context on a header-scoped route; membership failures answer `403` instead           |
| `409`  | Uniqueness conflict (duplicate email, duplicate client name/role name, member already present, active subscription exists)     |
| `429`  | Rate limited (see below)                                                                                                       |

Validation is **strict**: unknown body properties are rejected, not ignored
(`whitelist` + `forbidNonWhitelisted`). A stray `{"user_id": "…"}` in a `POST
/clients` body fails with `400` listing the offending field. Send exactly the
documented keys.

IDs are UUIDs — a malformed path id is `400`, not `404`, and the body is
`{"statusCode":400,"error":"Bad Request","message":"Validation failed (uuid is expected)"}`.
The same applies to `x-organization-id`: guards run before pipes, so a malformed
value is caught before any query and also answers `400`. A well-formed UUID that
simply does not exist is a different case and answers `403` (no membership) or
`404`, never `400`. Dates are ISO-8601 strings; `YYYY-MM-DD` for date-only fields
(`startDate`, `endDate`, `dueDate`).

### 8.3 Rate limits

| Bucket                       | Default             | Where                         |
| ---------------------------- | ------------------- | ----------------------------- |
| `default`                    | 300 requests / 60 s | Every endpoint, per client IP |
| `POST /auth/register`        | 5 / 15 min          | Per IP                        |
| `POST /auth/login`           | 10 / 15 min         | Per IP                        |
| `GET /auth/verify-email`     | 20 / 15 min         | Per IP                        |
| `POST /auth/forgot-password` | 5 / 15 min          | Per IP                        |
| `POST /auth/reset-password`  | 5 / 15 min          | Per IP                        |

Auth limits are per IP, not per account, and are **not** raised after a successful
call — a shared NAT or office IP will hit them. On `429` show a retry hint and
back off; do not auto-retry in a loop.

### 8.4 Deleting, trash and restore

Most resources are **soft-deleted**. `DELETE` hides the record from every
ordinary read, it does not destroy it, and the response says so.

| What you call | What happens |
| ------------- | ------------ |
| `DELETE /clients/{clientId}` | `200 { message }`; the client leaves every list and `GET` answers `404` |
| `GET /clients/trash` | The deleted clients, newest first |
| `POST /clients/{clientId}/restore` | `201` with the client as it was |

Trash and restore exist for **clients, projects, tasks, subtasks, time entries,
badges and teams**. `time-complexity` records and organization members are not
soft-deleted; those deletes are final.

A trash entry is always the same shape:

```json
{
  "id": "6f1c…",
  "deletedAt": "2026-03-04T09:12:44.201Z",
  "deletedBy": "9a2b…",
  "resource": { "id": "6f1c…", "name": "Acme Delivery", "…": "…" }
}
```

`deletedBy` is the id of the user who deleted it. That account may since have
been deleted (§3.8): the id stays, and looking it up answers `404`, so render it
as "unknown" rather than as a broken user. The record itself is under `resource`,
in the shape its own `GET` returns, so a trash row renders with the component you
already have.

#### Deletes that take other records with them

`projects`, `tasks` and `subtasks` contain work, and time is logged against
subtasks. Deleting any of the three **refuses** unless the request acknowledges
it:

```
DELETE /projects/{projectId}                 → 409
DELETE /projects/{projectId}?confirm=cascade → 200 { message, deleted: 47 }
```

`confirm=cascade` is the only accepted value; anything else is `400`. The `409`
message names the parameter, so a client can render it as-is:

> This delete takes the resource's contents with it, including time logged
> against them. Repeat the request with `?confirm=cascade` to confirm. The
> contents are recoverable afterwards, but not by re-typing them.

`deleted` counts every record that went, including the one you asked about — a
project plus its tasks, subtasks and time entries. **Show it.** A caller who
expected one row and reads forty-seven has just been told something important
about what the button does.

Leaves need no confirmation: `clients`, `badges`, `teams` and a single
`time entry` are removed with a plain `DELETE`.

#### What a restore brings back

A restore returns **exactly** what went down with the delete that flagged the
record, and nothing else. If a subtask was deleted deliberately a day before its
project, restoring the project leaves that subtask deleted.

Restoring a child while its parent is still deleted is refused with `409` and a
message naming the parent — a restored task under a deleted project would be
invisible to every read. Restore from the top down:

```
409 Restore the project instead, which brings back everything that went with it.
```

`404` means there is nothing to restore. `409` also means "this is not deleted" —
a restore on a live record is an error, not a no-op.

#### What a delete does *not* take

- Deleting a **client** leaves its projects, with `clientId: null`. The client is
  restorable, but until it is the projects still show no client.
- Deleting a **project** does not delete its client, and deleting a **team** does
  not delete its members' time entries. Historical time belongs to the person who
  logged it.
- A deleted client's **email is released** and may be reused by a new client.
  Restoring the original is then `409 Client email already registered` until the
  address is free again — reported as a conflict you can offer to resolve, not as
  a server error.

#### The one permanent delete

`DELETE /organizations/{organizationId}` is the exception. It removes the
organization and every record scoped to it, **including anything still in the
trash**, so there is nothing left to restore. It therefore requires the
organization's own name to be typed:

```
DELETE /organizations/{organizationId}                  → 409 (message names the org)
DELETE /organizations/{organizationId}?confirm=Acme Co  → 200 { message }
```

The name is matched exactly, and the `409` message contains it. A typo is `409`,
not `400`. Gate this behind a modal that shows the name the user must type.

---

## 9. Endpoint reference

`Org` = requires organization context. `Perm` = permission required.
Errors are the non-2xx codes each route documents **besides** two that apply
everywhere and are therefore not repeated per row:

- `401` on every authenticated route (absent from the public rows of §9.1).
- `429` on every route, including the public ones — see §8.3.

The Swagger document is authoritative; where a table here disagrees, the
document wins. Rows for modules that are not published yet describe routes the
API serves but the Swagger document does not yet list.

### 9.1 Public (no token)

| Method | Path                    | Body / query                 | Success                 | Errors              |
| ------ | ----------------------- | ---------------------------- | ----------------------- | ------------------- |
| `POST` | `/auth/register`        | `{ email, password, name? }` | `201 { message, user }` | `400`, `409`        |
| `POST` | `/auth/login`           | `{ email, password }`        | `201 { access_token }`  | `400`, `401`, `403` |
| `GET`  | `/auth/verify-email`    | `?token`                     | `200 { message }`       | `400`               |
| `POST` | `/auth/forgot-password` | `{ email }`                  | `201 { message }`       | `400`               |
| `POST` | `/auth/reset-password`  | `{ token, password }`        | `201 { message }`       | `400`               |
| `GET`  | `/auth/reset-password`  | `?token`                     | `200 { message }`       | `400`               |
| `GET`  | `/plans`                | —                            | `200 PlanResponseDto[]` | —                   |
| `GET`  | `/invitations/accept`   | `?token`                     | `200 InvitationPreviewResponseDto` | `400`, `409` |
| `POST` | `/invitations/accept`   | `{ token, name?, password? }` | `201 { message, organizationId, roleId, roleName }` | `400`, `409` |

Outside production, `register` and `forgot-password` (for an existing account)
also return the raw token and link, plus `emailSent`/`emailError` — see §4.
The invitation routes are public on purpose: the person accepting has no
membership yet, and usually no account either.

### 9.2 Authenticated, tenant-level (no organization needed)

| Method   | Path                  | Body                  | Success                                  | Errors              |
| -------- | --------------------- | --------------------- | ---------------------------------------- | ------------------- |
| `GET`    | `/auth/profile`       | —                     | `200 UserResponseDto`                    | `401`               |
| `PATCH`  | `/auth/profile`       | see §3.4              | `200 UserResponseDto`                    | `400`, `401`, `409` |
| `GET`    | `/subscription`       | —                     | `200 { subscription, usage[] }`          | `404`               |
| `POST`   | `/subscription`       | `{ planId, status? }` | `201 { subscription, usage[], message }` | `400`, `404`, `409` |
| `PATCH`  | `/subscription/plan`  | `{ planId }`          | `200 { subscription, usage[] }`          | `400`, `404`        |
| `DELETE` | `/subscription`       | —                     | `200 { message }`                        | `404`               |
| `GET`    | `/subscription/usage` | —                     | `200 PlanUsageDto[]`                     | `404`               |
| `GET`    | `/organizations`      | `?page&limit`         | `200 OrganizationPage`                   | `404`               |
| `POST`   | `/organizations`      | `{ name, status? }`   | `201 OrganizationResponseDto`            | `400`, `404`        |
| `GET`    | `/settings/account`   | —                     | `200 AccountResponseDto`                 | `401`               |
| `PATCH`  | `/settings/account/password` | `{ currentPassword, newPassword }` | `200 AccountResponseDto`   | `400`, `401`        |
| `PATCH`  | `/settings/account/email` | `{ email }`       | `200 AccountResponseDto`                 | `400`, `401`, `409` |
| `GET`    | `/settings/account/sessions` | —                | `200 SessionResponseDto[]`               | `401`               |
| `DELETE` | `/settings/account/sessions/{sessionId}` | —    | `200 { message }`                        | `400`, `401`, `404` |
| `DELETE` | `/settings/account` `?confirm=<email>` | `{ password }` | `200 { message }`                     | `400`, `401`, `409` |

`status` on subscribe accepts `trial | active | cancelled | suspended`; it
defaults to `active`.

### 9.3 Organizations, roles and members

| Method   | Path                                                         | Perm                  | Org  | Errors                     |
| -------- | ------------------------------------------------------------ | --------------------- | ---- | -------------------------- |
| `GET`    | `/organizations/{organizationId}`                            | `organization.view`   | path | `400`, `403`               |
| `PATCH`  | `/organizations/{organizationId}`                            | `organization.update` | path | `400`, `403`               |
| `DELETE` | `/organizations/{organizationId}` `?confirm=<name>`            | `organization.delete` | path | `400`, `403`, `409`         |
| `GET`    | `/organizations/{organizationId}/roles`                      | `role.view`           | path | `403`                      |
| `POST`   | `/organizations/{organizationId}/roles`                      | `role.create`         | path | `400`, `403`, `404`, `409` |
| `GET`    | `/organizations/{organizationId}/roles/{roleId}`             | `role.view`           | path | `403`, `404`               |
| `PATCH`  | `/organizations/{organizationId}/roles/{roleId}`             | `role.update`         | path | `400`, `403`, `404`        |
| `DELETE` | `/organizations/{organizationId}/roles/{roleId}`             | `role.delete`         | path | `403`, `404`               |
| `PUT`    | `/organizations/{organizationId}/roles/{roleId}/permissions` | `role.update`         | path | `400`, `403`, `404`        |
| `POST`   | `/organizations/{organizationId}/roles/{roleId}/assign`      | `role.assign`         | path | `400`, `403`, `404`, `409` |
| `DELETE` | `/organizations/{organizationId}/roles/{roleId}/assign`      | `role.assign`         | path | `403`, `404`               |
| `GET`    | `/organizations/{organizationId}/role-templates`             | `role.view`           | path | `403`                      |
| `GET`    | `/organizations/{organizationId}/members`                    | `member.view`         | path | `403`                      |
| `POST`   | `/organizations/{organizationId}/members`                    | `member.invite`       | path | `400`, `403`, `404`, `409` |
| `PATCH`  | `/organizations/{organizationId}/members/{userId}`           | `member.update`       | path | `403`, `404`               |
| `DELETE` | `/organizations/{organizationId}/members/{userId}`           | `member.remove`       | path | `403`, `404`               |
| `POST`   | `/organizations/{organizationId}/members/{userId}/deactivate` | `member.remove`      | path | `400`, `403`, `404`        |
| `POST`   | `/organizations/{organizationId}/members/{userId}/activate` | `member.update`       | path | `403`, `404`               |
| `POST`   | `/organizations/{organizationId}/invitations`               | `member.invite`       | path | `400`, `403`, `409`        |
| `GET`    | `/organizations/{organizationId}/invitations`               | `member.view`         | path | `403`                      |
| `DELETE` | `/organizations/{organizationId}/invitations/{invitationId}` | `member.invite`      | path | `403`, `404`, `409`        |

Behaviour worth encoding in the UI:

- `POST /members` takes **either** `userId` **or** `email`, plus `templateKey`
  (`owner | project_manager | developer | tester | viewer`). It grants access to
  an account that already exists — it does not send an invitation email, and it
  fails with `404` if the email has no account yet. To bring in an address that
  has no account, use `POST /invitations` instead.
- **Suspending a member does not remove them.** `POST …/members/{userId}/deactivate`
  keeps the role, the permissions and the plan seat, but the membership stops
  resolving, so every organization-scoped call the suspended member makes
  answers `403` from the next request on. It is idempotent, and `400` for your
  own membership — an administrator cannot lock the organization out alone.
  `POST …/members/{userId}/activate` brings that same membership back (same
  role, same seat, not a new row). Only `DELETE …/members/{userId}` destroys it
  and gives the seat back.
- **An invitation is a pending row with a seven-day window.** `POST /invitations`
  answers `201` with the invitation — and, outside production, `invitationToken`,
  `invitationLink` and `emailSent` — `409` if that address is already invited or
  already a member (the message points at `…/members/{userId}/activate` when the
  membership is suspended), `400` for a malformed address or an unknown
  `templateKey`. `GET /invitations` lists them, finished ones included, with
  `status` reported as `expired` for a pending row whose window has closed.
  `DELETE /invitations/{invitationId}` revokes: the emailed link stops working
  (`409` on both accept routes) and the address can be invited again at once; an
  already-accepted invitation is `409`, because the membership it created is
  removed with `DELETE …/members/{userId}`, not here.
- A member holds exactly one role. `PATCH /members/{userId}` **replaces** it.
- `PUT /roles/{roleId}/permissions` replaces the whole set — send the complete
  list, not a delta. Unknown permission strings are `400`.
- `POST /roles/{roleId}/assign` takes `{ userId }` and only works on a role with
  no assignee. `DELETE /roles/{roleId}/assign` takes **no body**: it detaches
  whoever currently holds that role.
- `GET /roles` returns role definitions _and_ assignments in one list; rows with
  `userId: null` are unassigned definitions.
- `DELETE /organizations/{organizationId}` is destructive and **permanent**: it
  removes the organization and every record scoped to it (roles, teams, clients,
  projects, tasks, time), including anything sitting in a trash. The API requires
  `?confirm=<organization name>`; without it the request is `409` and the `409`
  message contains the name to type. See [8.4](#84-deleting-trash-and-restore).

### 9.4 Teams

All routes: `Org` required via header.

| Method   | Path                                 | Perm                 | Errors                     |
| -------- | ------------------------------------ | -------------------- | -------------------------- |
| `GET`    | `/teams` `?page&limit`               | `team.view`          | `403`                      |
| `POST`   | `/teams`                             | `team.create`        | `400`, `403`               |
| `GET`    | `/teams/{teamId}`                    | `team.view`          | `403`, `404`               |
| `PATCH`  | `/teams/{teamId}`                    | `team.update`        | `400`, `403`, `404`        |
| `DELETE` | `/teams/{teamId}`                    | `team.delete`        | `403`, `404`               |
| `GET`    | `/teams/{teamId}/members`            | `team.view`          | `403`, `404`               |
| `POST`   | `/teams/{teamId}/members`            | `team.member.add`    | `400`, `403`, `404`, `409` |
| `PATCH`  | `/teams/{teamId}/members/{memberId}` | `team.member.add`    | `400`, `403`, `404`        |
| `DELETE` | `/teams/{teamId}/members/{memberId}` | `team.member.remove` | `403`, `404`               |
| `GET`    | `/teams/trash`                         | `team.view`          | `403`                      |
| `POST`   | `/teams/{teamId}/restore`              | `team.update`        | `403`, `404`, `409`        |

`POST /teams/{teamId}/members` accepts `userId` or `email`; the user must already
be a member of the organization, otherwise `400 The user must belong to the
organization before joining a team`. Adding someone twice is `409`. Deleting a
team soft-deletes it along with its memberships and task assignments, but
**keeps** historical time entries — the time belongs to whoever logged it. Use
`GET /teams/trash` and `POST /teams/{teamId}/restore` to see it and bring it
back; see [8.4](#84-deleting-trash-and-restore).

### 9.5 Clients, projects, badges

| Resource | List                           | Create                            | Read                                       | Update                   | Delete                    |
| -------- | ------------------------------ | --------------------------------- | ------------------------------------------ | ------------------------ | ------------------------- |
| Clients  | `GET /clients` `client.view`   | `POST /clients` `client.create`   | `GET /clients/{clientId}` `client.view`    | `PATCH` `client.update`  | `DELETE` `client.delete`  |
| Projects | `GET /projects` `project.view` | `POST /projects` `project.create` | `GET /projects/{projectId}` `project.view` | `PATCH` `project.update` | `DELETE` `project.delete` |
| Badges   | `GET /badges` `badge.view`     | `POST /badges` `badge.create`     | `GET /badges/{badgeId}` `badge.view`       | `PATCH` `badge.update`   | `DELETE` `badge.delete`   |

Each also answers `GET /{resource}/trash` (`*.view`) and
`POST /{resource}/{id}/restore` (`*.update`). `DELETE /projects/{projectId}`
additionally requires `?confirm=cascade` — see
[8.4](#84-deleting-trash-and-restore).

List endpoints take `?page&limit`; `/projects` also accepts `?status` and
`?clientId`. Creates return `400 403 409` where a uniqueness rule applies
(duplicate client email, duplicate client or badge name).

**Deleting a client does not delete its projects** — the projects survive with
`clientId: null`, and the client itself is recoverable from
`GET /clients/trash`. Handle a null `clientId` on `ProjectResponseDto`, and warn
before deleting a client that still has projects. `DELETE /projects/{projectId}`
answers `200 { message, deleted }`: `deleted` counts the project plus every task,
subtask and time entry that went with it.

### 9.6 Tasks and subtasks

| Method   | Path                                                            | Perm                                      | Errors              |
| -------- | --------------------------------------------------------------- | ----------------------------------------- | ------------------- |
| `GET`    | `/tasks` `?page&limit&status&priority&projectId&teamId&badgeId` | `task.view`                               | `403`               |
| `POST`   | `/tasks`                                                        | `task.create`                             | `400`, `403`, `404` |
| `GET`    | `/tasks/{taskId}`                                               | `task.view`                               | `403`, `404`        |
| `PATCH`  | `/tasks/{taskId}`                                               | `task.update`                             | `400`, `403`, `404` |
| `DELETE` | `/tasks/{taskId}` `?confirm=cascade`                            | `task.delete`                             | `400`, `403`, `404`, `409` |
| `GET`    | `/tasks/trash`                                                  | `task.view`                               | `403`               |
| `POST`   | `/tasks/{taskId}/restore`                                       | `task.update`                             | `403`, `404`, `409` |
| `GET`    | `/tasks/{taskId}/subtasks` `?page&limit&status&assignedTo`      | `subtask.view`                            | `403`, `404`        |
| `POST`   | `/tasks/{taskId}/subtasks`                                      | `subtask.create` **and** `subtask.assign` | `400`, `403`, `404` |
| `GET`    | `/tasks/{taskId}/subtasks/{subtaskId}`                          | `subtask.view`                            | `403`, `404`        |
| `PATCH`  | `/tasks/{taskId}/subtasks/{subtaskId}`                          | `subtask.update`                          | `400`, `403`, `404` |
| `DELETE` | `/tasks/{taskId}/subtasks/{subtaskId}` `?confirm=cascade`       | `subtask.delete`                          | `400`, `403`, `404`, `409` |
| `GET`    | `/tasks/{taskId}/subtasks/trash`                                | `subtask.view`                            | `403`, `404`        |
| `POST`   | `/tasks/{taskId}/subtasks/{subtaskId}/restore`                  | `subtask.update`                          | `403`, `404`, `409` |

Time is logged against **subtasks**, not tasks: `POST /time-entries` requires a
`subtaskId`. `POST` on subtasks needs both `subtask.create` and
`subtask.assign`, so a role that may create subtasks but not assign them gets
`403` — check both permissions before rendering the form.

**Deleting a task or a subtask takes the time logged against it with it** (the
foreign keys cascade: project → task → subtask → time entry). Deleting a project
therefore hides its tasks, their subtasks and every time entry under them. The
API does not block: it answers `409` until the request carries `?confirm=cascade`,
and the `200` reports how many rows went in `deleted`. Because the whole tree is
recoverable, that confirmation is about the size of the delete, not about
irreversibility — say what will disappear, then let them undo it later. See
[8.4](#84-deleting-trash-and-restore).

### 9.7 Time entries and timers

| Method   | Path                                                   | Perm                     | Errors                     |
| -------- | ------------------------------------------------------ | ------------------------ | -------------------------- |
| `GET`    | `/time-entries` `?page&limit&subtaskId&userId&running` | `time_entry.view`        | `403`                      |
| `POST`   | `/time-entries`                                        | `time_entry.create`      | `400`, `403`, `404`, `409` |
| `GET`    | `/time-entries/timer/active`                           | `time_entry.view`        | `403`                      |
| `POST`   | `/time-entries/timer/start`                            | `time_entry.start_timer` | `400`, `403`, `404`, `409` |
| `POST`   | `/time-entries/timer/stop`                             | `time_entry.stop_timer`  | `400`, `403`, `404`, `409` |
| `GET`    | `/time-entries/{timeEntryId}`                          | `time_entry.view`        | `403`, `404`               |
| `PATCH`  | `/time-entries/{timeEntryId}`                          | `time_entry.update`      | `400`, `403`, `404`        |
| `DELETE` | `/time-entries/{timeEntryId}`                          | `time_entry.delete`      | `403`, `404`               |
| `GET`    | `/time-entries/trash`                                 | `time_entry.view`        | `403`                      |
| `POST`   | `/time-entries/{timeEntryId}/restore`                 | `time_entry.update`      | `403`, `404`, `409`        |

- **Visibility is filtered, not rejected.** Without `time_entry.view_all` a
  caller only ever sees their own entries: `?userId=<other>` silently returns
  their own rows instead of `403`. Render "team timesheets" only when the role
  has `time_entry.view_all`.
- A running timer is one entry with `exitTime: null`, `isRunning: true`.
  `GET /time-entries/timer/active` returns `{ "entry": … | null }` — `null` is a
  normal state, not an error.
- `POST /time-entries/timer/start` → `201 { entry, message }`;
  `POST /time-entries/timer/stop` → `200 { entry, message }`. Starting a second
  timer while one runs is `409`.
- `durationSeconds` is server-computed (`exitTime - entryTime`); never calculate
  it in the browser, and treat `durationSeconds` of a running entry as growing
  client-side only for display.
- `?running=true` returns only running timers, `?running=false` only stopped ones.
  Omit the param for both.
- A deleted entry is restorable, but only while its subtask is not itself
  deleted — restoring time into a deleted subtask is `409`. A running timer
  deleted mid-flight is in the trash like any other entry.

### 9.8 Time complexity

| Method   | Path                                                          | Perm                     | Errors                     |
| -------- | ------------------------------------------------------------- | ------------------------ | -------------------------- |
| `GET`    | `/time-complexity` `?page&limit&taskId&subtaskId&name&status` | `time_complexity.view`   | `403`                      |
| `POST`   | `/time-complexity`                                            | `time_complexity.create` | `400`, `403`, `404`, `409` |
| `GET`    | `/time-complexity/variance/{taskId}`                          | `time_complexity.view`   | `403`, `404`               |
| `GET`    | `/time-complexity/{complexityId}`                             | `time_complexity.view`   | `403`, `404`               |
| `PATCH`  | `/time-complexity/{complexityId}`                             | `time_complexity.update` | `400`, `403`, `404`, `409` |
| `DELETE` | `/time-complexity/{complexityId}`                             | `time_complexity.delete` | `403`, `404`               |

Durations are sent as **seconds** (`minDuration`, `maxDuration`) and returned in
both forms: `minDurationSeconds`/`maxDurationSeconds` plus the formatted
`minDuration`/`maxDuration` (`"02:00:00"`). Only one **active** estimate may exist
per task/subtask combination — a second one is `409`; archiving the first
(`status: 'archived'`) frees the slot.

`GET /time-complexity/variance/{taskId}` returns
`{ subtaskId, title, actualSeconds, minSeconds, maxSeconds, variance }` where
`variance` is `within | under | over`. A `null` `actualSeconds` means no time was
logged against that subtask.

### 9.9 Dashboard

| Method | Path                  | Perm                   |
| ------ | --------------------- | ---------------------- |
| `GET`  | `/dashboard/overview` | none beyond membership |
| `GET`  | `/dashboard/projects` | none beyond membership |
| `GET`  | `/dashboard/clients`  | none beyond membership |
| `GET`  | `/dashboard/overdue`  | none beyond membership |

These four require a valid token **and** organization context, but no specific
permission — every member of the organization can read them. Do not gate the
dashboard on `dashboard.view`.

Shared query parameters on `overview`, `projects` and `clients`:

| Param           | Type                                                  | Default                   |
| --------------- | ----------------------------------------------------- | ------------------------- |
| `from`          | ISO date                                              | 30 days ago (inclusive)   |
| `to`            | ISO date                                              | now (inclusive)           |
| `projectId`     | uuid                                                  | — (whole organization)    |
| `groupBy`       | `user \| project \| client \| task \| subtask \| day` | —                         |
| `completedOnly` | boolean                                               | — (ignore running timers) |

`/dashboard/overdue` accepts only `from` and `to`. Invalid dates are `400`.

---

## 10. Data shapes

### 10.1 Enumerations

| Field                                                 | Allowed values                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| `user.status`                                         | `active`, `inactive`, `suspended` (only the first two via `PATCH /auth/profile`) |
| `subscription.status`                                 | `trial`, `active`, `cancelled`, `suspended`                                      |
| `organization.status`, `team.status`, `client.status` | `active`, `inactive`, `archived`                                                 |
| `teamMember.status`                                   | `pending`, `active`, `inactive`, `removed`                                       |
| `teamMember.role`                                     | `lead`, `member`, `observer`                                                     |
| `member.status`                                       | `active`, `deactivated`                                                          |
| `invitation.status`                                   | `pending`, `accepted`, `revoked`, `expired` (the last is reported, never stored) |
| `project.status`                                      | `planned`, `active`, `on_hold`, `completed`, `cancelled`                         |
| `task.status`                                         | `todo`, `in_progress`, `in_review`, `done`, `cancelled`                          |
| `task.priority`, `timeComplexity.name`                | `low`, `medium`, `high`, `critical`                                              |
| `subtask.status`                                      | `todo`, `in_progress`, `done`, `cancelled`                                       |
| `timeComplexity.status`                               | `active`, `archived`                                                             |

### 10.2 Entities

Nullable fields are shown as `| null`. Read-only fields (server-managed) are
marked **ro**.

**User** (`UserResponseDto`): `id`, `organizationId | null`, `email`, `name | null`,
`status | null`, `isVerified`, `createdAt` ro, `updatedAt` ro.

**Plan** (`PlanResponseDto`): `id`, `name`, `description | null`, `maxUsers`,
`maxProjects`, `maxStorageGb`, `maxOrganizations`, `price` (decimal **string**,
e.g. `"79.00"` — parse before display).

**Subscription** (`SubscriptionResponseDto`): `id`, `userId`, `planId | null`,
`plan | null` (embedded `PlanResponseDto`), `status`, `createdAt` ro,
`updatedAt` ro.

**Organization**: `id`, `tenantId` ro, `name`, `status`, `createdAt` ro. Create
body: `{ name, status? }`.

**Role** (`RoleResponseDto`): `id`, `organizationId` ro, `userId | null` (`null`
= definition not yet assigned), `name`, `description | null`, `permissions[]`
(each `{ id, roleId, name, description, createdAt }`), `createdAt`/`updatedAt` ro.

**Member** (`MemberResponseDto`): `userId`, `email`, `name | null`, `roleId`,
`roleName`, `status` (`active` | `deactivated`), `permissions[]` (dotted
strings, not objects).

**Invitation** (`InvitationResponseDto`): `id` ro, `organizationId` ro, `email`,
`templateKey`, `roleName`, `status`, `expiresAt`, `invitedBy | null`,
`acceptedAt | null`, `createdAt` ro. `POST` answers with
`CreateInvitationResponseDto` (the same fields, plus `invitationToken`,
`invitationLink`, `emailSent`, `emailError` outside production). `GET /invitations/accept` answers with
`InvitationPreviewResponseDto`: `email`, `organizationName`, `roleName`,
`status`, `expiresAt`, `accountExists`, `permissions[]`.

**Team**: `id`, `organizationId` ro, `name`, `description | null`, `status`,
`createdAt` ro.

**TeamMember**: `id`, `teamId`, `userId`, `user | null` (embedded user),
`role`, `status`, `joinedAt` ro. Note both `userId` and `user` are returned.

**Client**: `id`, `organizationId` ro, `name`, `email | null`, `phone | null`,
`industry | null`, `website | null`, `status`. Create body adds all optional
fields.

**Project**: `id`, `organizationId` ro, `clientId | null`, `name`,
`description | null`, `status`, `startDate | null`, `endDate | null`,
`budget | null` (decimal string). Plan limit `maxProjects` applies to `POST`.

**Badge**: `id`, `organizationId` ro, `name`, `description | null`,
`color | null` (hex, e.g. `#ef4444`), `icon | null`.

**Task**: `id`, `projectId`, `teamId | null`, `badgeId | null`, `title`,
`description | null`, `priority`, `status`, `dueDate | null`, `createdAt`/`updatedAt` ro.

**Subtask**: `id`, `taskId`, `assignedTo | null` (a **user id**), `title`,
`description | null`, `status`, `dueDate | null`, `createdAt`/`updatedAt` ro.
Create body: `{ title, description?, assignedTo?, status?, dueDate? }`.

**TimeEntry**: `id`, `subtaskId`, `userId`, `entryTime`, `exitTime | null`,
`durationSeconds` ro, `isRunning` ro, `createdAt` ro.

**TimeComplexity**: `id`, `taskId`, `subtaskId | null`, `name`, `status`,
`minDuration`, `maxDuration`, `minDurationSeconds` ro, `maxDurationSeconds` ro.

### 10.3 Dashboard payloads

| Endpoint              | Response                                 |
| --------------------- | ---------------------------------------- |
| `/dashboard/overview` | `DashboardOverviewDto`                   |
| `/dashboard/projects` | `{ total, items: ProjectProgressDto[] }` |
| `/dashboard/clients`  | `{ total, items: ClientSummaryDto[] }`   |
| `/dashboard/overdue`  | `{ total, items: OverdueSubtaskDto[] }`  |

`DashboardOverviewDto`: `from`, `to`, `projects`, `tasks`, `subtasks`,
`timeEntries`, `totalSeconds`, `tasksByStatus[]`, `subtasksByStatus[]`,
`tasksByPriority[]`, `timeByGroup[]`, `variance`, `completionRate`,
`averageSecondsPerEntry`.

- `StatusCountDto` = `{ status, count }`
- `TimeGroupDto` = `{ key, label | null, seconds, entries }` — `key` is the
  `groupBy` value, `label` the display name
- `VarianceSummaryDto` = `{ compared, within, under, over, overSeconds }`
- `ProjectProgressDto` = `{ projectId, name, status, tasks, completedTasks, subtasks, completedSubtasks, completionRate | null, totalSeconds, startDate | null, endDate | null }`
- `ClientSummaryDto` = `{ clientId, name, status, projects, totalSeconds }`
- `OverdueSubtaskDto` = `{ subtaskId, title, status, dueDate, daysOverdue, priority }`

Note there is **no** `percentage` field anywhere: `completionRate` is a rounded
0–1 ratio, so multiply by 100 for display. It is `null` on a project row with no
tasks, and `0` on `/dashboard/overview` when the organization has no tasks.

---

## 11. Integration checklist

- [ ] `baseURL` includes `/api/v1`; nothing else hard-codes the prefix
- [ ] `Authorization: Bearer …` attached from a token store; cleared on `401` and logout
- [ ] `x-organization-id` attached from an organization store; re-prompted on the `404` that mentions the header
- [ ] `x-organization-id` preflight verified once in a real browser (§2)
- [ ] Verification page reads `?token=` and calls `GET /auth/verify-email`; treats `Email already verified` as success
- [ ] Reset page reads `?token=` from its **own** route and POSTs to `/auth/reset-password`; the emailed URL itself only validates the token (`GET /auth/reset-password`), it never resets anything
- [ ] Invitation page owns `/invitations/accept?token=…`: `GET` first to show who invited whom, `POST` only on submit; `409` means the link was already used (§4)
- [ ] Accepting on behalf of a brand-new account sends `token`, `name` and `password` together — a `400` on accept means the credentials were missing or the token is dead
- [ ] Password inputs validated with `^(?=.*[A-Za-z])(?=.*\d).{8,128}$` before submit
- [ ] Password change and email change both re-authenticate the user afterwards: both end the token in hand (§3.8)
- [ ] `403 Missing required permission` → hide/disable the control, do not retry
- [ ] `status: deactivated` on a member row → offer "Activate", never "Invite"; re-inviting a suspended member answers `409` and names the activate route (§9.3)
- [ ] `404` mentioning `x-organization-id` → switch organization, not an empty-state message
- [ ] `409` on `POST /subscription` → route the user to plan change (`PATCH /subscription/plan`)
- [ ] `400 Plan limit reached…` / `Subscription is cancelled…` → prompt to upgrade/reactivate
- [ ] Error `message` normalised for both `string` and `string[]`
- [ ] Request bodies contain only documented keys (unknown keys are `400`)
- [ ] Pagination reads `totalPages` and clamps `limit ≤ 100`
- [ ] Timesheet screens hidden without `time_entry.view_all`
- [ ] `429` handled with backoff, no automatic retry storm
- [ ] Types generated from `docs/openapi.json` rather than hand-written

## 12. Known limitations

Backend behaviours that constrain the client today — plan for them rather than
discovering them in QA:

1. **Refresh is absolute, not sliding.** A session ends
   `REFRESH_TOKEN_TTL_DAYS` after it was created no matter how often it is
   refreshed (default 30), and the customer re-authenticates. That is deliberate:
   a sliding window never ends, so a token that leaked once would stay usable for
   as long as its holder kept using it.
2. **The reset email link targets the API, and with the wrong verb.** It needs a
   frontend-owned page (see §4).
3. **Invitation links point at the API host, and there is no resend.** The
   invitation email is built from `APP_BASE_URL` like verification and reset
   (§4), so the invitee lands on raw JSON unless you own an
   `/invitations/accept?token=…` page. A pending invitation lives seven days and
   then reports `expired`; there is no reminder and no resend button — a fresh
   link is `DELETE /invitations/{invitationId}` followed by a new
   `POST /invitations`.
4. **Deletes cascade, sometimes quietly.** Deleting an organization removes all of
   its records; deleting a team removes memberships and task assignments;
   deleting a project removes its tasks, their subtasks **and the time logged
   against them**. Deleting a _client_ is the quiet one — its projects survive
   with `clientId: null`.
5. **No filtering or sorting on most lists.** Only the filters listed per route
   exist; there is no `sort`, `search`, `orderBy` or date-range parameter on list
   endpoints.
6. **No soft deletes.** Deletes are hard, and the only "archived" concept is the
   `status` enum on organizations, teams, clients and time-complexity estimates —
   plus `member.status`, which suspends a membership instead of deleting it
   (§9.3). Nothing a delete removed is recoverable from the UI.
7. **`?userId` on time entries is ignored without `view_all`** — a silent
   filter, not a `403`.
8. **Swagger docs, not this file, are the schema source of truth.** If the two
   ever disagree, `docs/openapi.json` and the running server win. Regenerate the
   file with `npm run docs:openapi` whenever a controller or DTO changes.
