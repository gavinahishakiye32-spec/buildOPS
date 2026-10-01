# Plan: Full Swagger Documentation + Jest Validation

## Context
The app already has partial Swagger setup (`main.ts`, DTOs with `@ApiProperty`, controller with some `@ApiOperation`/`@ApiResponse` decorators). Three endpoints are hidden with `@ApiExcludeEndpoint`. The goal is to document **all** endpoints and add a jest e2e test that validates the generated OpenAPI document matches the real API behavior.

Notable issue found: `login` endpoint is documented as `status: 200` but NestJS `@Post` returns `201` by default. The jest validation spec will catch and enforce correctness.

## Status: DONE

### 1. Removed `@ApiExcludeEndpoint` and documented hidden endpoints
**File:** `src/auth/auth.controller.ts`
- Removed `@ApiExcludeEndpoint()` from `forgot-password`, `reset-password`, `profile`
- Added `@ApiOperation`, `@ApiResponse` for each
- Added `@ApiBearerAuth()` to `profile` (protected endpoint)
- Fixed login response status: `200` → `201` to match actual NestJS default (`@Post` returns 201)

### 2. Shared swagger setup
**File (new):** `src/swagger.setup.ts`
- Extracted the `DocumentBuilder` config from `main.ts` into `setupSwagger(app)` so main + tests share one source of truth
- Refactored `src/main.ts` to use it

### 3. Swagger e2e validation spec
**File (new):** `test/swagger.e2e-spec.ts`
17 tests that boot the app (mocked services, real HTTP/JWT/swagger), fetch `/api-json`, and:
- Validate all 6 endpoints are documented with correct HTTP methods
- Validate the exact documented status-code sets match reality
- Validate request payload schemas and response DTO schemas exist
- Exercise every endpoint and assert real status codes + body shapes match the docs

Verification results:
- `npm run test:e2e` → 18 passed (incl. existing e2e) ✓
- `npm test` → 31 passed ✓
- `npm run lint` → clean ✓
- `npm run build` → clean ✓
- Live boot: `/api-json` serves all 6 endpoints (POST /auth/register 201,409; POST /auth/login 201,401; GET /auth/verify-email 200,400; POST /auth/forgot-password 201; POST /auth/reset-password 201,400; GET /auth/profile 200,401 [secured]) ✓
