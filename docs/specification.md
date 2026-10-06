# BuildOps — MVP Technical Architecture & Workflow Specification

> Archived baseline. This file is the original specification, kept verbatim so no requirement is
> ever lost. Where the implementation deviates or adds information, the authoritative record is
> `docs/frontend-guide.md` → §9 "Endpoint reference" and §12 "Known limitations", and, for the
> database, `schema.sql`. The machine-readable contract is `docs/openapi.json` (regenerate with
> `npm run docs:openapi`).

## 1. Product Overview

BuildOps is a multi-tenant platform for managing clients, projects, teams, tasks, subtasks, work time and time-complexity estimation. The MVP connects these capabilities into one operational flow while providing subscription limits, organization-level authorization and task classification through badges.

**Core flow:** User → Subscription/Plan → Tenant → Organizations → Organization Roles & Permissions / Teams / Clients / Projects → Tasks → Subtasks → Time → Time Complexity

## 2. Core Domain Model

| Model | Key Data | Purpose |
|---|---|---|
| User | id, organization_id, email, password_hash, name, status, created_at, updated_at | Represents an account that can authenticate and participate in organizations. |
| Tenant | id, user_id, plan_id, status, created_at, updated_at | Represents the subscribed customer/owner and connects the account to its selected Plan. |
| Plan | id, name, description, max_users, max_projects, max_storage_gb, max_organizations, price | Defines subscription capacity and commercial limits applied to a Tenant. |
| Organization | id, tenant_id, name, status, created_at | Represents a company/workspace under a Tenant. |
| Role | id, organization_id, user_id, name, description, status, created_at, updated_at | Defines an access role for members of an Organization, such as Developer, Tester or Project Manager. `status` carries the membership state: `active` or `deactivated`. |
| Permission | id, role_id, name, description, created_at, updated_at | Defines an action or access capability granted through a Role within an Organization. |
| OrganizationInvitation | id, organization_id, email, template_key, role_name, token_hash, status, expires_at, invited_by, created_at | Holds an invitation emailed to an address that has no account yet. The Role it promises is only created when the link is accepted; the raw token exists only in the email, never in the database. |
| Badge | id, organization_id, name, description, color, icon | Provides organization-defined labels/classification that can be attached to Tasks. |
| Team | id, organization_id, name, description, status, created_at | Represents a working group inside an Organization. |
| TeamMember | id, team_id, user_id, role, status, joined_at | Connects Users to Teams and stores team membership and team-specific role/status. |
| Client | id, organization_id, name, email, phone, industry, website, status | Represents a customer managed by an Organization. |
| Project | id, organization_id, client_id, name, description, status, start_date, end_date, budget | Represents client work being delivered. |
| Task | id, project_id, team_id, badge_id, title, description, priority, status, due_date | Represents a work item assigned to a Team and optionally classified with a Badge. |
| Subtask | id, task_id, assigned_to, title, description, status, due_date, created_at, updated_at | Represents the individual execution item assigned to a User. |
| TimeEntry | id, subtask_id, user_id, entry_time, exit_time, created_at | Represents time spent by a User on a Subtask. |
| TimeComplexity | id, task_id, subtask_id, name, status, min_time, max_time | Defines the expected minimum and maximum time boundaries for a Task or Subtask, enabling time-complexity estimation and variance analysis. |

## 3. Detailed Field Definitions

The following field-level definitions align with the BuildOps ERD and are the authoritative reference for migrations and ORM schemas.

### 3.1 User

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | Primary identifier |
| organization_id | UUID (FK) | Owning Organization |
| email | VARCHAR(255), UNIQUE | Login identifier; unique at database level |
| password_hash | VARCHAR(255) | Secure password hash (Argon2id or bcrypt) |
| name | VARCHAR(255) | Display name |
| status | VARCHAR(50) | Account lifecycle status |
| created_at | TIMESTAMP | Record creation timestamp |
| updated_at | TIMESTAMP | Record update timestamp |

### 3.2 Tenant

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | Primary identifier |
| user_id | UUID (FK) | Owning User |
| plan_id | UUID (FK) | Selected Plan |
| status | VARCHAR(50) | Subscription status |
| created_at | TIMESTAMP | Record creation timestamp |
| updated_at | TIMESTAMP | Record update timestamp |

### 3.3 Plan

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | Primary identifier |
| name | VARCHAR(255) | Plan name |
| description | TEXT | Plan description |
| max_users | INTEGER | Maximum users permitted |
| max_projects | INTEGER | Maximum projects permitted |
| max_storage_gb | INTEGER | Maximum storage in GB |
| max_organizations | INTEGER | Maximum organizations permitted |
| price | DECIMAL | Subscription price |

### 3.4 Organization

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | Primary identifier |
| tenant_id | UUID (FK) | Owning Tenant |
| name | VARCHAR(255) | Organization name |
| status | VARCHAR(50) | Lifecycle status |
| created_at | TIMESTAMP | Record creation timestamp |

### 3.5 Role

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | Primary identifier |
| organization_id | UUID (FK) | Owning Organization |
| user_id | UUID (FK) | Applicable User (organization member) |
| name | VARCHAR(255) | Role name (e.g. Developer, Tester, Project Manager) |
| description | TEXT | Role description |
| status | VARCHAR(20) | Membership status: `active` (default) or `deactivated` |
| created_at | TIMESTAMP | Record creation timestamp |
| updated_at | TIMESTAMP | Record update timestamp |

A Role row with a `user_id` is the membership, so `status` is what makes a
member a *suspended* member: `deactivated` keeps the row, the permissions and
the plan seat, but the membership stops resolving, so every organization-scoped
request the member makes is refused until it is set back to `active`. Only one
`active` row may exist per (organization, user), and inviting an address whose
membership is `deactivated` is refused with a message that points at
reactivation instead of creating a second role.

### 3.6 Permission

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | Primary identifier |
| role_id | UUID (FK) | Parent Role |
| name | VARCHAR(255) | Permission name (e.g. project.create) |
| description | TEXT | Permission description |
| created_at | TIMESTAMP | Record creation timestamp |
| updated_at | TIMESTAMP | Record update timestamp |

### 3.7 Badge

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | Primary identifier |
| organization_id | UUID (FK) | Owning Organization |
| name | VARCHAR(255) | Badge name |
| description | TEXT | Badge description |
| color | VARCHAR(50) | Display color |
| icon | VARCHAR(255) | Display icon reference |

### 3.8 Team

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | Primary identifier |
| organization_id | UUID (FK) | Owning Organization |
| name | VARCHAR(255) | Team name |
| description | TEXT | Team description |
| status | VARCHAR(50) | Lifecycle status |
| created_at | TIMESTAMP | Record creation timestamp |

### 3.9 TeamMember

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | Primary identifier |
| team_id | UUID (FK) | Parent Team |
| user_id | UUID (FK) | Member User |
| role | VARCHAR(50) | Team-specific role |
| status | VARCHAR(50) | Membership status |
| joined_at | TIMESTAMP | Date and time the User joined the Team |

### 3.10 Client

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | Primary identifier |
| organization_id | UUID (FK) | Owning Organization |
| name | VARCHAR(255) | Client name |
| email | VARCHAR(255) | Contact email |
| phone | VARCHAR(50) | Contact phone |
| industry | VARCHAR(100) | Industry classification |
| website | VARCHAR(255) | Website URL |
| status | VARCHAR(50) | Lifecycle status |

### 3.11 Project

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | Primary identifier |
| organization_id | UUID (FK) | Owning Organization |
| client_id | UUID (FK) | Linked Client |
| name | VARCHAR(255) | Project name |
| description | TEXT | Project description |
| status | VARCHAR(50) | Lifecycle status |
| start_date | DATE | Delivery start |
| end_date | DATE | Delivery end |
| budget | DECIMAL(10,2) | Financial scope |

### 3.12 Task

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | Primary identifier |
| project_id | UUID (FK) | Parent Project |
| team_id | UUID (FK) | Assigned Team |
| badge_id | UUID (FK, nullable) | Optional Badge classification |
| title | VARCHAR(255) | Task title |
| description | TEXT | Task description |
| priority | VARCHAR(50) | Priority level |
| status | VARCHAR(50) | Workflow status |
| due_date | DATE | Due date |

### 3.13 Subtask

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | Primary identifier |
| task_id | UUID (FK) | Parent Task |
| assigned_to | UUID (FK) | Assigned User (must be a TeamMember of the parent Task's Team) |
| title | VARCHAR(255) | Subtask title |
| description | TEXT | Subtask description |
| status | VARCHAR(50) | Workflow status |
| due_date | DATE | Due date |
| created_at | TIMESTAMP | Record creation timestamp |
| updated_at | TIMESTAMP | Record update timestamp |

### 3.14 TimeEntry

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | Primary identifier |
| subtask_id | UUID (FK) | Parent Subtask |
| user_id | UUID (FK) | User who logged time |
| entry_time | TIMESTAMP | Timer start |
| exit_time | TIMESTAMP (nullable) | Timer stop; NULL while active |
| created_at | TIMESTAMP | Record creation timestamp |

### 3.15 TimeComplexity

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | Primary identifier |
| task_id | UUID (FK) | Associated Task |
| subtask_id | UUID (FK) | Associated Subtask |
| name | VARCHAR(50) | Complexity label (e.g. low, medium, high, critical) |
| status | VARCHAR(50) | Complexity status |
| min_time | TIMESTAMP | Minimum expected time boundary |
| max_time | TIMESTAMP | Maximum expected time boundary |

### 3.16 OrganizationInvitation

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | Primary identifier |
| organization_id | UUID (FK) | Inviting Organization |
| email | VARCHAR(255) | Invited address, normalized (trimmed, lower case) |
| template_key | VARCHAR(50) | Role template the invitation promises (owner, project_manager, developer, tester, viewer) |
| role_name | VARCHAR(255) | Display name of that template at invite time, so history survives a template edit |
| token_hash | VARCHAR(64) | SHA-256 of the emailed token; the raw token is never stored |
| status | VARCHAR(20) | `pending`, `accepted` or `revoked`; `expired` is derived from `expires_at`, never stored |
| expires_at | TIMESTAMP | End of the seven-day window |
| invited_by | UUID (FK) | User who sent the invitation |
| accepted_at | TIMESTAMP | When it was accepted, null otherwise |
| created_at | TIMESTAMP | Record creation timestamp |
| updated_at | TIMESTAMP | Record update timestamp |

The table deliberately has no `user_id` and no `role_id`: an invitation belongs to an address, not to an account, because at invite time the invitee may not have an account yet. The Role it promises is created only on acceptance, at which point the account exists and the plan seat can be checked against a real user — so an invitation nobody accepted consumes no capacity.

**Constraints:** one `pending` invitation per (organization, email), enforced by a partial unique index over `status = 'pending'`, and one token per invitation. Rows are kept after use rather than deleted: an accepted invitation is the record of how somebody joined, and a revoked one is what makes "this invitation was revoked" distinguishable from "there is no such invitation". A lapsed pending row is deleted when the same address is invited again, so the unique index holds a fresh invitation instead of a dead one.

## 4. Authentication, Subscription & Tenant Model

### 4.1 Registration

The User model is created first. The password is transformed into a secure password hash before persistence. The raw password is never stored.

**Implementation flow:** POST /auth/register → validate input → normalize email → check unique email → hash password using Argon2id or bcrypt → create User → return safe user information.

### 4.2 Plan Selection and Tenant Creation

A subscription is tied to a Plan. The Plan defines the capacity available to the Tenant, including maximum users, projects, storage, organizations and price. After successful subscription, the Tenant stores the selected plan and account status.

**Flow:** User → Select Plan → Successful Subscription → Tenant(plan_id) → Enforce Plan Limits

Plan limits are checked before operations that consume tenant capacity. For example, creating an Organization must respect max_organizations, adding users must respect max_users, and creating projects must respect max_projects. Storage limits apply when storage-consuming functionality is introduced.

### 4.3 Organizations

A Tenant can create multiple Organizations subject to its Plan. Each Organization is owned through tenant_id. All operational records are scoped to an Organization so that data from one Organization cannot be accessed through another.

**Flow:** Tenant → Organization → Organization Roles & Permissions / Teams / Clients / Projects

## 5. Authorization Model

Authentication identifies the User. Authorization determines what an authenticated User is allowed to do. Authorization is enforced in the backend and evaluated within the active Organization context.

A Role belongs to an Organization and defines the access a member has in that Organization. A Permission represents a named capability such as creating projects, updating tasks, managing teams or viewing time data. The Role model includes a user_id reference that links the applicable User to the role assignment, ensuring each organization member has a resolvable role before authorization is enforced.

**Authorization flow:** Request → Authentication Middleware → Tenant Context → Organization Context → Resolve Role/Permissions → Resource Ownership Check → Business Service → Database

For a protected request, the backend should:

1. Resolve the authenticated User.
2. Resolve the active Organization.
3. Verify that the requested resource belongs to that Organization.
4. Evaluate the User's applicable Role and its Permissions.
5. Perform the business operation only when authorization succeeds.

**Role/permission responsibility:** Role and Permission define what an organization member can do within that Organization. TeamMember.role remains available for team-specific membership information and should not be treated as the source of organization-level access.

**Membership state:** a Role row whose `status` is `deactivated` resolves to nothing. The member keeps the role, its permissions and their plan seat, but every organization-scoped request they make is refused until the membership is activated again. Deactivation is refused for the acting administrator's own membership, so an organization can never be left without somebody able to restore it. Removing the member (`DELETE …/members/{userId}`) is the operation that destroys the membership and frees the seat.

## 6. Role & Permission Management Workflow

**Flow:** Organization → Create Role → Attach Permissions → Assign applicable Role to Organization Member → User makes request → Permission Check → Allow/Deny

An authorized organization administrator creates a Role and defines its description. Permissions are then associated with that Role. When a User performs an action, the backend evaluates the User's applicable Role and the Permissions attached to it.

Example: a Developer role may be allowed to create and update development tasks, a Tester role may be allowed to update testing status and test-related work, while a Project Manager may be allowed to create and update projects and tasks. The exact permission names should be defined by the application and kept consistent across API endpoints.

**Adding a member who has no account yet:** when the invited address has no User row, there is nothing to attach a Role to. The administrator therefore invites the address instead: an `OrganizationInvitation` holds the address, the role template and the hash of a token sent by email, and the Role — and the plan seat it consumes — are created only when the invitation is accepted through the emailed link, which also creates the account. One pending invitation per address; a second is refused until the first is revoked or expires after seven days. Inviting an address whose membership exists but is deactivated is refused as well, with the answer naming activation rather than a second role.

## 7. Team Management

Teams are created inside an Organization. Users are connected to Teams through TeamMember. A User must belong to the relevant Organization before becoming a Team member.

**Flow:** Organization → Team → TeamMember → User

TeamMember is the membership model. It stores team-specific role information, membership status and joined_at without placing team membership directly on User. Team membership is also used when validating Subtask assignment.

## 8. CRM / Client Management

Clients are organization-owned records. The service layer derives the Organization from the authenticated context and verifies it before creating, reading, updating or deleting a Client.

**Flow:** Organization → Client

Example: POST /clients → authenticate → authorize organization-level client permission → validate fields (name, email, phone, industry, website, status) → create Client with organization_id → return client.

## 9. Project Management

A Project belongs to an Organization and is connected to a Client. When creating a Project, the backend verifies that the selected Client belongs to the same Organization.

**Flow:** Organization → Client → Project

Project creation also checks the applicable Plan limit before saving. The Project service validates status, start_date, end_date and budget. The budget field uses DECIMAL(10,2) to preserve financial precision.

## 10. Task Management & Badges

Tasks belong to Projects and are assigned to Teams. A Task can also reference an organization-defined Badge. Badges provide a consistent visual or categorical label for work without changing the core task workflow.

**Flow:** Organization → Badge → Task ← Team ← Organization; Project → Task

When creating or updating a Task, the backend verifies that the Project, Team and Badge all belong to the same Organization. A Badge may contain a name, description, color and icon so the frontend can present the task classification consistently.

The Task service remains responsible for title, description, priority, status and due_date. Badge assignment is an additional classification step rather than a replacement for priority or status.

## 11. Subtasks & Individual Assignment

Subtasks are the execution-level work items. A Subtask is assigned to an individual User, but that User must be a member of the Team assigned to the parent Task.

**Flow:** Task → Team → TeamMember → User → Subtask

Assignment is validated by querying TeamMember before the Subtask is created or reassigned. The backend should also confirm that the parent Task, Team and User all belong to the same Organization. Subtask fields include title (VARCHAR 255), description (TEXT), status (VARCHAR 50), due_date (DATE), created_at and updated_at.

## 12. Time Logging

TimeEntry is attached to a Subtask. The application can derive the Task and Project through parent relationships, so duplicate project/task references are not required.

**Flow:** User → TimeEntry → Subtask → Task → Project

### 12.1 Start Timer

- User opens an authorized Subtask.
- Backend verifies the User can work on that Subtask.
- Create TimeEntry with entry_time = current timestamp, exit_time = NULL, and created_at = current timestamp.
- Return active timer state to the frontend.

### 12.2 Stop Timer

- Find the User's active TimeEntry.
- Set exit_time = current timestamp.
- Validate exit_time >= entry_time.
- Calculate duration as exit_time − entry_time.
- Return the completed time record.

## 13. Time Complexity Management

TimeComplexity defines the expected minimum and maximum time boundaries for a Task or Subtask, enabling estimation, variance analysis and delivery forecasting.

**Flow:** Task → TimeComplexity ← Subtask

The TimeComplexity record references both a parent Task and, where applicable, a Subtask, so the expected duration envelope can be defined at either level. Fields:

- **name** (VARCHAR 50): the complexity classification label (e.g. low, medium, high, critical).
- **status** (VARCHAR 50): the lifecycle status of the complexity record.
- **min_time** (TIMESTAMP): the minimum expected completion time.
- **max_time** (TIMESTAMP): the maximum expected completion time.

When a TimeEntry is recorded against a Subtask, the backend can compare actual duration (exit_time − entry_time) against the applicable TimeComplexity min_time and max_time to surface variance to the dashboard and reporting layers.

**Validation rules:**

- min_time must be less than or equal to max_time.
- task_id must reference a Task within the same Organization.
- subtask_id, when provided, must belong to the referenced Task.
- Only one active TimeComplexity record should exist per Task/Subtask combination unless versioning is explicitly enabled.

## 14. End-to-End Operational Workflow

**Account:** User registers → authenticates → selects Plan → subscription succeeds → Tenant is created/activated.

1. User registers and authenticates.
2. User selects a Plan and completes subscription.
3. Tenant is created/activated with the selected plan.
4. Tenant creates one or more Organizations within plan limits.
5. Organization configures Roles and attaches Permissions.
6. Users are associated with the appropriate organization-level access role — directly when the account already exists, or through an emailed invitation that creates the role on acceptance when it does not.
7. Organization creates Teams and adds Users through TeamMember.
8. Organization creates Clients with contact fields (email, phone, industry, website) and status.
9. Organization creates Projects and links them to Clients, subject to max_projects, with start_date, end_date and budget.
10. Organization creates Badges for reusable task classification.
11. Projects receive Tasks assigned to Teams and optionally linked to Badges.
12. Tasks receive Subtasks assigned to Team Members.
13. Team Members perform work and update statuses.
14. Team Members start/stop timers or create manual TimeEntries.
15. Time is aggregated through Subtask → Task → Project for operational visibility.
16. TimeComplexity records define expected min_time and max_time boundaries for Tasks and Subtasks, enabling variance analysis against actual TimeEntry durations.
17. All protected operations are subject to authorization, organization ownership and applicable Plan limits.

## 15. API / Service Boundary Pattern

The same request-processing pattern should be applied across modules:

**Request → Authentication → Tenant/Organization Context → Plan Check (when applicable) → Permission Check → Relationship Validation → Business Service → Database → Response**

This prevents controllers from becoming the source of business rules and ensures that tenant isolation, subscription limits, organization authorization and relationship validation are consistently enforced.

## 16. Database & API Practices

- Use UUIDs for primary identifiers.
- Use foreign keys to enforce relationships.
- Keep email unique at the database level (User.email and Client.email where applicable).
- Use transactions for multi-step operations that must succeed or fail together.
- Add indexes to commonly filtered relationship fields such as organization_id, tenant_id, project_id, task_id, subtask_id, team_id, role_id, permission_id, badge_id and user_id.
- Validate business relationships in the service layer even when foreign keys are present.
- Use pagination for large client, project, task and time-entry lists.
- Keep Plan limits centralized so the same subscription rules are applied consistently across services.
- Preserve field types as defined in Section 3 (VARCHAR lengths, DECIMAL precision, DATE vs TIMESTAMP) to ensure consistency between migrations, ORM schemas and the ERD.
- Enforce the TimeComplexity invariant min_time ≤ max_time at the database level through a CHECK constraint.

## 17. Security Best Practices

- **Passwords:** Argon2id/bcrypt; never plaintext.
- **Sessions:** secure, HttpOnly cookies or short-lived access tokens with a safe refresh strategy.
- **Transport:** HTTPS everywhere outside local development.
- **Authorization:** server-side Tenant and Organization checks on every protected resource.
- **Permission enforcement:** check the applicable organization Role/Permission before executing protected business operations.
- **Input validation:** validate types, lengths, dates, budget values, complexity time boundaries and allowed statuses.
- **Rate limiting:** protect login and other abuse-sensitive endpoints.
- **Secrets:** keep database credentials, token keys and provider credentials outside source code.
- **Logging:** log security-relevant events without logging passwords, tokens or other secrets.
- **Database:** use parameterized queries/ORM protections and least-privilege database credentials.
- **Data isolation:** never allow a client-provided ID to bypass Tenant/Organization ownership checks.

## 18. MVP Implementation Order

1. Authentication: User registration, login, password security and sessions.
2. Subscription foundation: Plan definitions (including max_organizations and price), Tenant creation and plan-limit enforcement.
3. Tenant & Organization: subscription state, organization management and tenant isolation.
4. Authorization: Roles, Permissions, role assignment and server-side permission checks.
5. Teams: team creation and membership.
6. CRM: Client CRUD with email, phone, industry, website and organization-level access.
7. Projects: Project CRUD with start_date, end_date, budget, client validation and project plan limits.
8. Badges: Badge CRUD, organization ownership and task badge assignment.
9. Tasks/Subtasks: team assignment, badge validation, individual assignment and status workflow.
10. Time Logging: timer (entry_time/exit_time), manual entries, created_at and duration calculations.
11. Time Complexity: TimeComplexity CRUD, min_time/max_time validation, task/subtask linkage and variance reporting.
12. Dashboard: basic project, task, time and complexity visibility.
13. Security and end-to-end testing across tenant isolation, permissions and plan limits.

## 19. MVP Result

A successful MVP allows a real customer to move from account creation to actual delivery work inside one system while keeping access and subscription boundaries clear, and provides time-complexity estimation to forecast delivery and detect variance.

**Primary business flow:** User → Plan → Tenant → Organization → Role/Permission → Client → Project → Team → Task → Badge (optional) → Subtask → Time → TimeComplexity

The architecture keeps ownership, authorization, subscription limits and operational relationships clear at every level while leaving room to expand later into billing, HR, analytics, storage and integrations.
