import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260814023352_workmesh_terminal_im",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`workmesh_terminal_intent\` (
          \`id\` text NOT NULL,
          \`terminal_id\` text NOT NULL,
          \`task_id\` text,
          \`path\` text NOT NULL,
          \`mode\` text NOT NULL,
          \`workspace_mode\` text NOT NULL,
          \`status\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`workmesh_terminal_intent_pk\` PRIMARY KEY(\`id\`, \`path\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`workmesh_terminal_message_event\` (
          \`cursor\` integer PRIMARY KEY AUTOINCREMENT,
          \`id\` text NOT NULL,
          \`message_id\` text NOT NULL,
          \`terminal_id\` text NOT NULL,
          \`sequence\` integer NOT NULL,
          \`kind\` text NOT NULL,
          \`content\` text NOT NULL,
          \`metadata\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_expires\` integer NOT NULL,
          CONSTRAINT \`fk_workmesh_terminal_message_event_message_id_workmesh_terminal_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`workmesh_terminal_message\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`workmesh_terminal_message\` (
          \`id\` text PRIMARY KEY,
          \`sender_terminal_id\` text NOT NULL,
          \`recipient_terminal_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`status\` text NOT NULL,
          \`reply_to_message_id\` text,
          \`idempotency_key\` text,
          \`claimed_by_terminal_id\` text,
          \`result\` text,
          \`time_created\` integer NOT NULL,
          \`time_delivered\` integer,
          \`time_read\` integer,
          \`time_claimed\` integer,
          \`time_completed\` integer
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`workmesh_terminal_outbox\` (
          \`delivery_id\` text PRIMARY KEY,
          \`recipient_terminal_id\` text NOT NULL,
          \`envelope\` text NOT NULL,
          \`attempts\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_next_attempt\` integer NOT NULL,
          \`time_acknowledged\` integer
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`workmesh_terminal_session\` (
          \`terminal_id\` text PRIMARY KEY,
          \`session_id\` text,
          \`display_name\` text NOT NULL,
          \`role\` text,
          \`capabilities\` text NOT NULL,
          \`status\` text NOT NULL,
          \`workspace_mode\` text NOT NULL,
          \`workspace_path\` text,
          \`task_id\` text,
          \`last_heartbeat_at\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`workmesh_terminal_intent_terminal_status_idx\` ON \`workmesh_terminal_intent\` (\`terminal_id\`,\`status\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`workmesh_terminal_message_event_id_idx\` ON \`workmesh_terminal_message_event\` (\`id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`workmesh_terminal_message_event_message_sequence_idx\` ON \`workmesh_terminal_message_event\` (\`message_id\`,\`sequence\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`workmesh_terminal_message_event_message_created_idx\` ON \`workmesh_terminal_message_event\` (\`message_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`workmesh_terminal_message_event_expires_idx\` ON \`workmesh_terminal_message_event\` (\`time_expires\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`workmesh_terminal_message_sender_idempotency_idx\` ON \`workmesh_terminal_message\` (\`sender_terminal_id\`,\`idempotency_key\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`workmesh_terminal_message_recipient_status_created_idx\` ON \`workmesh_terminal_message\` (\`recipient_terminal_id\`,\`status\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`workmesh_terminal_message_conversation_created_idx\` ON \`workmesh_terminal_message\` (\`sender_terminal_id\`,\`recipient_terminal_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`workmesh_terminal_outbox_pending_idx\` ON \`workmesh_terminal_outbox\` (\`time_acknowledged\`,\`time_next_attempt\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`workmesh_terminal_session_status_heartbeat_idx\` ON \`workmesh_terminal_session\` (\`status\`,\`last_heartbeat_at\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
