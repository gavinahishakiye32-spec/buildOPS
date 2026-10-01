BEGIN;

DROP TABLE IF EXISTS time_complexity CASCADE;
DROP TABLE IF EXISTS time_entries CASCADE;
DROP TABLE IF EXISTS subtasks CASCADE;
DROP TABLE IF EXISTS tasks CASCADE;
DROP TABLE IF EXISTS projects CASCADE;
DROP TABLE IF EXISTS clients CASCADE;
DROP TABLE IF EXISTS team_members CASCADE;
DROP TABLE IF EXISTS teams CASCADE;
DROP TABLE IF EXISTS badges CASCADE;
DROP TABLE IF EXISTS permissions CASCADE;
DROP TABLE IF EXISTS roles CASCADE;
DROP TABLE IF EXISTS organizations CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS tenants CASCADE;
DROP TABLE IF EXISTS plans CASCADE;

CREATE TABLE plans (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name              VARCHAR(255) NOT NULL,
    description       TEXT,
    max_users         INTEGER,
    max_projects      INTEGER,
    max_storage_gb    INTEGER,
    max_organizations INTEGER,
    price             DECIMAL(10,2),
    created_at        TIMESTAMP NOT NULL DEFAULT now(),
    updated_at        TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID,
    plan_id    UUID,
    status     VARCHAR(50),
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id            UUID,
    email                      VARCHAR(255) NOT NULL UNIQUE,
    password_hash              VARCHAR(255) NOT NULL,
    name                       VARCHAR(255),
    status                     VARCHAR(50),
    is_verified                BOOLEAN NOT NULL DEFAULT FALSE,
    verification_token         VARCHAR(64),
    verification_token_expires TIMESTAMP,
    reset_token                VARCHAR(64),
    reset_token_expires        TIMESTAMP,
    created_at                 TIMESTAMP NOT NULL DEFAULT now(),
    updated_at                 TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID,
    name       VARCHAR(255) NOT NULL,
    status     VARCHAR(50),
    created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE roles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID,
    user_id         UUID,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    created_at      TIMESTAMP NOT NULL DEFAULT now(),
    updated_at      TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role_id     UUID,
    name        VARCHAR(255),
    description TEXT,
    created_at  TIMESTAMP NOT NULL DEFAULT now(),
    updated_at  TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE badges (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    color           VARCHAR(50),
    icon            VARCHAR(255)
);

CREATE TABLE teams (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    status          VARCHAR(50),
    created_at      TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE team_members (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id   UUID,
    user_id   UUID,
    role      VARCHAR(50),
    status    VARCHAR(50),
    joined_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE clients (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID,
    name            VARCHAR(255) NOT NULL,
    email           VARCHAR(255) UNIQUE,
    phone           VARCHAR(50),
    industry        VARCHAR(100),
    website         VARCHAR(255),
    status          VARCHAR(50)
);

CREATE TABLE projects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID,
    client_id       UUID,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    status          VARCHAR(50),
    start_date      DATE,
    end_date        DATE,
    budget          DECIMAL(10,2)
);

CREATE TABLE tasks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  UUID,
    team_id     UUID,
    badge_id    UUID,
    title       VARCHAR(255) NOT NULL,
    description TEXT,
    priority    VARCHAR(50),
    status      VARCHAR(50),
    due_date    DATE,
    created_at  TIMESTAMP NOT NULL DEFAULT now(),
    updated_at  TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE subtasks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id     UUID,
    assigned_to UUID,
    title       VARCHAR(255) NOT NULL,
    description TEXT,
    status      VARCHAR(50),
    due_date    DATE,
    created_at  TIMESTAMP NOT NULL DEFAULT now(),
    updated_at  TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE time_entries (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subtask_id  UUID,
    user_id     UUID,
    entry_time  TIMESTAMP,
    exit_time   TIMESTAMP,
    created_at  TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE time_complexity (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id       UUID,
    subtask_id    UUID,
    name          VARCHAR(50),
    status        VARCHAR(50),
    min_duration  INTERVAL,
    max_duration  INTERVAL
);

ALTER TABLE tenants
    ADD CONSTRAINT fk_tenants_user_id  FOREIGN KEY (user_id) REFERENCES users(id)  ON DELETE CASCADE,
    ADD CONSTRAINT fk_tenants_plan_id  FOREIGN KEY (plan_id) REFERENCES plans(id)  ON DELETE SET NULL;

ALTER TABLE users
    ADD CONSTRAINT fk_users_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;

ALTER TABLE organizations
    ADD CONSTRAINT fk_organizations_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE roles
    ADD CONSTRAINT fk_roles_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    ADD CONSTRAINT fk_roles_user_id         FOREIGN KEY (user_id)         REFERENCES users(id)         ON DELETE SET NULL;

ALTER TABLE roles
    ADD CONSTRAINT uq_roles_org_user UNIQUE (organization_id, user_id);

ALTER TABLE permissions
    ADD CONSTRAINT fk_permissions_role_id FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE;

ALTER TABLE badges
    ADD CONSTRAINT fk_badges_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;

ALTER TABLE teams
    ADD CONSTRAINT fk_teams_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;

ALTER TABLE team_members
    ADD CONSTRAINT fk_team_members_team_id FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
    ADD CONSTRAINT fk_team_members_user_id FOREIGN KEY (user_id) REFERENCES users(id)  ON DELETE CASCADE;

ALTER TABLE team_members
    ADD CONSTRAINT uq_team_members_team_user UNIQUE (team_id, user_id);

ALTER TABLE clients
    ADD CONSTRAINT fk_clients_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;

ALTER TABLE projects
    ADD CONSTRAINT fk_projects_organization_id FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    ADD CONSTRAINT fk_projects_client_id       FOREIGN KEY (client_id)       REFERENCES clients(id)       ON DELETE SET NULL;

ALTER TABLE tasks
    ADD CONSTRAINT fk_tasks_project_id FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    ADD CONSTRAINT fk_tasks_team_id    FOREIGN KEY (team_id)    REFERENCES teams(id)    ON DELETE SET NULL,
    ADD CONSTRAINT fk_tasks_badge_id   FOREIGN KEY (badge_id)   REFERENCES badges(id)   ON DELETE SET NULL;

ALTER TABLE subtasks
    ADD CONSTRAINT fk_subtasks_task_id     FOREIGN KEY (task_id)     REFERENCES tasks(id) ON DELETE CASCADE,
    ADD CONSTRAINT fk_subtasks_assigned_to FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE time_entries
    ADD CONSTRAINT fk_time_entries_subtask_id FOREIGN KEY (subtask_id) REFERENCES subtasks(id) ON DELETE CASCADE,
    ADD CONSTRAINT fk_time_entries_user_id    FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE SET NULL;

ALTER TABLE time_complexity
    ADD CONSTRAINT fk_time_complexity_task_id    FOREIGN KEY (task_id)    REFERENCES tasks(id)    ON DELETE CASCADE,
    ADD CONSTRAINT fk_time_complexity_subtask_id FOREIGN KEY (subtask_id) REFERENCES subtasks(id) ON DELETE CASCADE;

ALTER TABLE time_complexity
    ADD CONSTRAINT chk_time_complexity_min_max CHECK (min_duration <= max_duration),
    ADD CONSTRAINT uq_time_complexity_scope UNIQUE (task_id, subtask_id, status);

CREATE INDEX idx_tenants_user_id              ON tenants(user_id);
CREATE INDEX idx_tenants_plan_id              ON tenants(plan_id);
CREATE INDEX idx_users_organization_id        ON users(organization_id);
CREATE INDEX idx_organizations_tenant_id      ON organizations(tenant_id);
CREATE INDEX idx_roles_organization_id        ON roles(organization_id);
CREATE INDEX idx_roles_user_id                ON roles(user_id);
CREATE INDEX idx_permissions_role_id          ON permissions(role_id);
CREATE INDEX idx_badges_organization_id       ON badges(organization_id);
CREATE INDEX idx_teams_organization_id        ON teams(organization_id);
CREATE INDEX idx_team_members_team_id         ON team_members(team_id);
CREATE INDEX idx_team_members_user_id         ON team_members(user_id);
CREATE INDEX idx_clients_organization_id      ON clients(organization_id);
CREATE INDEX idx_projects_organization_id     ON projects(organization_id);
CREATE INDEX idx_projects_client_id           ON projects(client_id);
CREATE INDEX idx_tasks_project_id             ON tasks(project_id);
CREATE INDEX idx_tasks_team_id                ON tasks(team_id);
CREATE INDEX idx_tasks_badge_id               ON tasks(badge_id);
CREATE INDEX idx_subtasks_task_id             ON subtasks(task_id);
CREATE INDEX idx_subtasks_assigned_to         ON subtasks(assigned_to);
CREATE INDEX idx_time_entries_subtask_id      ON time_entries(subtask_id);
CREATE INDEX idx_time_entries_user_id         ON time_entries(user_id);
CREATE INDEX idx_time_complexity_task_id      ON time_complexity(task_id);
CREATE INDEX idx_time_complexity_subtask_id   ON time_complexity(subtask_id);

COMMIT;