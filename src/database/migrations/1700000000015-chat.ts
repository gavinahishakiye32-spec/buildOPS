import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Chat: channels, messages and per-participant read markers.
 *
 * A channel is typed by what it is attached to. The four "auto" scopes --
 * organization, project, task, subtask -- are unique per scope through partial
 * indexes, so two clients racing to open the same project room converge on one
 * row instead of splitting the conversation. Direct channels are not covered by
 * a unique index: their uniqueness is "exactly this set of participants", which
 * a partial index cannot express for a variable-size set, so the service
 * dedupes inside a transaction instead.
 *
 * Channels are hard-deleted with their scope (`ON DELETE CASCADE`): a deleted
 * project's room has nothing left to say. Messages carry the standard soft
 * delete columns, because a deleted message is a tombstone people have already
 * seen in their clients, and because moderation needs an audit trail
 * (`deleted_by`). `body` length is checked on the table so the database and the
 * validators cannot drift apart.
 *
 * Read state lives on the participant row (`last_read_at`), not on the message:
 * "unread" is a property of a viewer, not of a row, and putting it on the
 * message would need one row per reader per message.
 *
 * New permissions are seeded into the role definitions created before this
 * migration, matched by the template display name the way `RoleService` names
 * them, mirroring the milestones migration. New organizations need none of
 * that: the running code builds the template permissions at creation time.
 *
 * The permission descriptions mirror `RoleService.describePermission`
 * (`<action> <resource>`).
 */
export class Chat1700000000015 implements MigrationInterface {
  name = 'Chat1700000000015';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "chat_channels" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "organization_id" uuid NOT NULL,
      "type" character varying(20) NOT NULL,
      "project_id" uuid,
      "task_id" uuid,
      "subtask_id" uuid,
      "name" character varying(255),
      "last_message_at" TIMESTAMP,
      "created_by" uuid,
      "created_at" TIMESTAMP NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
      CONSTRAINT "PK_chat_channels" PRIMARY KEY ("id"),
      CONSTRAINT "FK_chat_channels_organization" FOREIGN KEY ("organization_id")
        REFERENCES "organizations" ("id") ON DELETE CASCADE,
      CONSTRAINT "FK_chat_channels_project" FOREIGN KEY ("project_id")
        REFERENCES "projects" ("id") ON DELETE CASCADE,
      CONSTRAINT "FK_chat_channels_task" FOREIGN KEY ("task_id")
        REFERENCES "tasks" ("id") ON DELETE CASCADE,
      CONSTRAINT "FK_chat_channels_subtask" FOREIGN KEY ("subtask_id")
        REFERENCES "subtasks" ("id") ON DELETE CASCADE,
      CONSTRAINT "CHK_chat_channels_type"
        CHECK ("type" IN ('organization', 'project', 'task', 'subtask', 'direct'))
    )`);

    await queryRunner.query(
      `CREATE INDEX "IDX_chat_channels_organization_id"
         ON "chat_channels" ("organization_id")`,
    );
    // One auto channel per scope, enforced by the database rather than by a
    // check-then-insert in the service.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_chat_channels_organization"
         ON "chat_channels" ("organization_id") WHERE "type" = 'organization'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_chat_channels_project"
         ON "chat_channels" ("project_id")
         WHERE "type" = 'project' AND "project_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_chat_channels_task"
         ON "chat_channels" ("task_id")
         WHERE "type" = 'task' AND "task_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_chat_channels_subtask"
         ON "chat_channels" ("subtask_id")
         WHERE "type" = 'subtask' AND "subtask_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_chat_channels_last_message"
         ON "chat_channels" ("organization_id", "last_message_at" DESC)`,
    );

    await queryRunner.query(`CREATE TABLE "chat_messages" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "organization_id" uuid NOT NULL,
      "channel_id" uuid NOT NULL,
      "sender_id" uuid NOT NULL,
      "body" text NOT NULL,
      "edited_at" TIMESTAMP,
      "deleted_at" TIMESTAMP,
      "deleted_by" uuid,
      "created_at" TIMESTAMP NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
      CONSTRAINT "PK_chat_messages" PRIMARY KEY ("id"),
      CONSTRAINT "FK_chat_messages_organization" FOREIGN KEY ("organization_id")
        REFERENCES "organizations" ("id") ON DELETE CASCADE,
      CONSTRAINT "FK_chat_messages_channel" FOREIGN KEY ("channel_id")
        REFERENCES "chat_channels" ("id") ON DELETE CASCADE,
      CONSTRAINT "FK_chat_messages_sender" FOREIGN KEY ("sender_id")
        REFERENCES "users" ("id") ON DELETE CASCADE,
      CONSTRAINT "CHK_chat_messages_body"
        CHECK (length("body") BETWEEN 1 AND 4000)
    )`);

    await queryRunner.query(
      `CREATE INDEX "IDX_chat_messages_channel_created"
         ON "chat_messages" ("channel_id", "created_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_chat_messages_organization"
         ON "chat_messages" ("organization_id")`,
    );

    await queryRunner.query(`CREATE TABLE "chat_channel_participants" (
      "channel_id" uuid NOT NULL,
      "user_id" uuid NOT NULL,
      "last_read_at" TIMESTAMP,
      "joined_at" TIMESTAMP NOT NULL DEFAULT now(),
      CONSTRAINT "PK_chat_channel_participants" PRIMARY KEY ("channel_id", "user_id"),
      CONSTRAINT "FK_chat_channel_participants_channel" FOREIGN KEY ("channel_id")
        REFERENCES "chat_channels" ("id") ON DELETE CASCADE,
      CONSTRAINT "FK_chat_channel_participants_user" FOREIGN KEY ("user_id")
        REFERENCES "users" ("id") ON DELETE CASCADE
    )`);

    await queryRunner.query(
      `CREATE INDEX "IDX_chat_channel_participants_user"
         ON "chat_channel_participants" ("user_id")`,
    );

    // Existing roles gain the permissions the templates now describe, matched
    // on the display name the way the milestones migration does it: a custom
    // role is left alone, and only roles that should hold these receive them.
    await queryRunner.query(`
      WITH template_permissions(template_name, permission_name, permission_description) AS (
        VALUES
          ('Owner',             'chat.view',    'view chat'),
          ('Owner',             'chat.create',  'create chat'),
          ('Owner',             'chat.manage',  'manage chat'),
          ('Project Manager',   'chat.view',    'view chat'),
          ('Project Manager',   'chat.create',  'create chat'),
          ('Project Manager',   'chat.manage',  'manage chat'),
          ('Developer',         'chat.view',    'view chat'),
          ('Developer',         'chat.create',  'create chat'),
          ('Tester',            'chat.view',    'view chat'),
          ('Tester',            'chat.create',  'create chat'),
          ('Viewer',            'chat.view',    'view chat')
      )
      INSERT INTO "permissions" ("id", "role_id", "name", "description", "created_at", "updated_at")
      SELECT gen_random_uuid(), r."id", tp.permission_name, tp.permission_description, now(), now()
      FROM "roles" r
      JOIN template_permissions tp ON tp.template_name = r."name"
      WHERE NOT EXISTS (
        SELECT 1 FROM "permissions" p WHERE p."role_id" = r."id" AND p."name" = tp.permission_name
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "permissions"
      WHERE "name" IN ('chat.view', 'chat.create', 'chat.manage')
      AND "role_id" IN (
        SELECT "id" FROM "roles"
        WHERE "name" IN ('Owner', 'Project Manager', 'Developer', 'Tester', 'Viewer')
      )
    `);

    await queryRunner.query(`DROP INDEX "IDX_chat_channel_participants_user"`);
    await queryRunner.query(`DROP TABLE "chat_channel_participants"`);

    await queryRunner.query(`DROP INDEX "IDX_chat_messages_organization"`);
    await queryRunner.query(`DROP INDEX "IDX_chat_messages_channel_created"`);
    await queryRunner.query(`DROP TABLE "chat_messages"`);

    await queryRunner.query(`DROP INDEX "IDX_chat_channels_last_message"`);
    await queryRunner.query(`DROP INDEX "UQ_chat_channels_subtask"`);
    await queryRunner.query(`DROP INDEX "UQ_chat_channels_task"`);
    await queryRunner.query(`DROP INDEX "UQ_chat_channels_project"`);
    await queryRunner.query(`DROP INDEX "UQ_chat_channels_organization"`);
    await queryRunner.query(`DROP INDEX "IDX_chat_channels_organization_id"`);
    await queryRunner.query(`DROP TABLE "chat_channels"`);
  }
}
