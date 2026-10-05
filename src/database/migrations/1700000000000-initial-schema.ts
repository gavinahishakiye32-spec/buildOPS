import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The baseline. It reproduces the schema that `synchronize: true` used to derive
 * from the entities, table for table and constraint for constraint, so a
 * database built by migrations is indistinguishable from one built by
 * `synchronize`. That equivalence is what let `synchronize` be deleted: the
 * e2e suites truncate rather than create, and they pass unchanged against a
 * schema that came from this file.
 *
 * `synchronize` was never safe to keep — it derives DDL from the current
 * entities on every boot, so a renamed column was a dropped column and there
 * was no way to review a schema change before it ran against real data. This
 * migration is the reviewed, ordered replacement.
 *
 * Two pre-existing quirks are fixed here rather than reproduced, because a
 * baseline is the one chance to get them right. Neither changes a response
 * body, so the committed OpenAPI document stays valid:
 *
 *  - `time_entries.user_id` was `NOT NULL` while its foreign key was
 *    `ON DELETE SET NULL`, a combination Postgres rejects at runtime: deleting
 *    a user who has logged time raised a foreign key violation. No code path
 *    deletes users, so the rule was latent, but it was wrong. `RESTRICT` now
 *    states the intent -- logged time is not separable from its author -- and
 *    fails loudly if user deletion is ever added.
 *  - `tenants.user_id` had no unique constraint even though every query treats
 *    the subscription as one-per-user (`findByUserId` takes a single row). Two
 *    concurrent subscribes could insert two subscriptions and the second would
 *    silently shadow the first. It is unique now.
 *
 * `organizations` and the operational tables carry no `deleted_at` yet; that
 * arrives with its own migration so this file stays a faithful baseline.
 */
export class InitialSchema1700000000000 implements MigrationInterface {
  name = 'InitialSchema1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    await queryRunner.query(`
      CREATE TABLE "plans" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying(255) NOT NULL,
        "description" text,
        "max_users" integer NOT NULL DEFAULT 1,
        "max_projects" integer NOT NULL DEFAULT 1,
        "max_storage_gb" integer NOT NULL DEFAULT 1,
        "max_organizations" integer NOT NULL DEFAULT 1,
        "price" numeric(10,2) NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_plans" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "organization_id" uuid,
        "email" character varying(255) NOT NULL,
        "password_hash" character varying(255) NOT NULL,
        "name" character varying(255),
        "status" character varying(50),
        "is_verified" boolean NOT NULL DEFAULT false,
        "verification_token" character varying(64),
        "verification_token_expires" TIMESTAMP,
        "reset_token" character varying(64),
        "reset_token_expires" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_users" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_users_email" UNIQUE ("email")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "tenants" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "plan_id" uuid,
        "status" character varying(50) NOT NULL DEFAULT 'trial',
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_tenants" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_tenants_user_id" UNIQUE ("user_id"),
        CONSTRAINT "FK_tenants_user" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_tenants_plan" FOREIGN KEY ("plan_id")
          REFERENCES "plans" ("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "organizations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "name" character varying(255) NOT NULL,
        "status" character varying(50) NOT NULL DEFAULT 'active',
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_organizations" PRIMARY KEY ("id"),
        CONSTRAINT "FK_organizations_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenants" ("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "roles" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "organization_id" uuid NOT NULL,
        "user_id" uuid,
        "name" character varying(255) NOT NULL,
        "description" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_roles" PRIMARY KEY ("id"),
        CONSTRAINT "FK_roles_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_roles_user" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "permissions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "role_id" uuid NOT NULL,
        "name" character varying(255) NOT NULL,
        "description" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_permissions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_permissions_role" FOREIGN KEY ("role_id")
          REFERENCES "roles" ("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "teams" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "organization_id" uuid NOT NULL,
        "name" character varying(255) NOT NULL,
        "description" text,
        "status" character varying(50) NOT NULL DEFAULT 'active',
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_teams" PRIMARY KEY ("id"),
        CONSTRAINT "FK_teams_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations" ("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "team_members" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "team_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "role" character varying(50) NOT NULL DEFAULT 'member',
        "status" character varying(50) NOT NULL DEFAULT 'active',
        "joined_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_team_members" PRIMARY KEY ("id"),
        CONSTRAINT "FK_team_members_team" FOREIGN KEY ("team_id")
          REFERENCES "teams" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_team_members_user" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "clients" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "organization_id" uuid NOT NULL,
        "name" character varying(255) NOT NULL,
        "email" character varying(255),
        "phone" character varying(50),
        "industry" character varying(100),
        "website" character varying(255),
        "status" character varying(50) NOT NULL DEFAULT 'active',
        CONSTRAINT "PK_clients" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_clients_email" UNIQUE ("email"),
        CONSTRAINT "FK_clients_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations" ("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "projects" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "organization_id" uuid NOT NULL,
        "client_id" uuid,
        "name" character varying(255) NOT NULL,
        "description" text,
        "status" character varying(50) NOT NULL DEFAULT 'planned',
        "start_date" DATE,
        "end_date" DATE,
        "budget" numeric(10,2),
        CONSTRAINT "PK_projects" PRIMARY KEY ("id"),
        CONSTRAINT "FK_projects_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_projects_client" FOREIGN KEY ("client_id")
          REFERENCES "clients" ("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "badges" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "organization_id" uuid NOT NULL,
        "name" character varying(255) NOT NULL,
        "description" text,
        "color" character varying(50),
        "icon" character varying(255),
        CONSTRAINT "PK_badges" PRIMARY KEY ("id"),
        CONSTRAINT "FK_badges_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations" ("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "tasks" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "project_id" uuid NOT NULL,
        "team_id" uuid,
        "badge_id" uuid,
        "title" character varying(255) NOT NULL,
        "description" text,
        "priority" character varying(50) NOT NULL DEFAULT 'medium',
        "status" character varying(50) NOT NULL DEFAULT 'todo',
        "due_date" DATE,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_tasks" PRIMARY KEY ("id"),
        CONSTRAINT "FK_tasks_project" FOREIGN KEY ("project_id")
          REFERENCES "projects" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_tasks_team" FOREIGN KEY ("team_id")
          REFERENCES "teams" ("id") ON DELETE SET NULL,
        CONSTRAINT "FK_tasks_badge" FOREIGN KEY ("badge_id")
          REFERENCES "badges" ("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "subtasks" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "task_id" uuid NOT NULL,
        "assigned_to" uuid,
        "title" character varying(255) NOT NULL,
        "description" text,
        "status" character varying(50) NOT NULL DEFAULT 'todo',
        "due_date" DATE,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_subtasks" PRIMARY KEY ("id"),
        CONSTRAINT "FK_subtasks_task" FOREIGN KEY ("task_id")
          REFERENCES "tasks" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_subtasks_assigned_to" FOREIGN KEY ("assigned_to")
          REFERENCES "users" ("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "time_entries" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "subtask_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "entry_time" TIMESTAMP NOT NULL,
        "exit_time" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_time_entries" PRIMARY KEY ("id"),
        CONSTRAINT "FK_time_entries_subtask" FOREIGN KEY ("subtask_id")
          REFERENCES "subtasks" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_time_entries_user" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "time_complexity" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "task_id" uuid NOT NULL,
        "subtask_id" uuid,
        "name" character varying(50) NOT NULL,
        "status" character varying(50) NOT NULL DEFAULT 'active',
        "min_duration" interval NOT NULL,
        "max_duration" interval NOT NULL,
        CONSTRAINT "PK_time_complexity" PRIMARY KEY ("id"),
        CONSTRAINT "FK_time_complexity_task" FOREIGN KEY ("task_id")
          REFERENCES "tasks" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_time_complexity_subtask" FOREIGN KEY ("subtask_id")
          REFERENCES "subtasks" ("id") ON DELETE CASCADE
      )
    `);

    // The permission checks in `PlanLimitService` resolve the owning
    // subscription by joining organizations to tenants, and the seat count
    // joins roles to organizations. Both scan on the join keys, so they are
    // indexed rather than left to sequential scans on a growing table.
    await queryRunner.query(
      `CREATE INDEX "IDX_organizations_tenant_id" ON "organizations" ("tenant_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_roles_organization_id" ON "roles" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_roles_user_id" ON "roles" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_permissions_role_id" ON "permissions" ("role_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_projects_organization_id" ON "projects" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_tasks_project_id" ON "tasks" ("project_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_subtasks_task_id" ON "subtasks" ("task_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_time_entries_subtask_id" ON "time_entries" ("subtask_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse dependency order. The indexes go with their tables.
    await queryRunner.query(`DROP TABLE "time_complexity"`);
    await queryRunner.query(`DROP TABLE "time_entries"`);
    await queryRunner.query(`DROP TABLE "subtasks"`);
    await queryRunner.query(`DROP TABLE "tasks"`);
    await queryRunner.query(`DROP TABLE "badges"`);
    await queryRunner.query(`DROP TABLE "projects"`);
    await queryRunner.query(`DROP TABLE "clients"`);
    await queryRunner.query(`DROP TABLE "team_members"`);
    await queryRunner.query(`DROP TABLE "teams"`);
    await queryRunner.query(`DROP TABLE "permissions"`);
    await queryRunner.query(`DROP TABLE "roles"`);
    await queryRunner.query(`DROP TABLE "organizations"`);
    await queryRunner.query(`DROP TABLE "tenants"`);
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TABLE "plans"`);
  }
}
