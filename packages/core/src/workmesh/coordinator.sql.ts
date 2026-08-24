import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

/** 项目本地终端会话。WorkMesh 项目数据库本身已完成项目隔离，因此无需重复保存项目 ID。 */
export const WorkMeshTerminalSessionTable = sqliteTable(
  "workmesh_terminal_session",
  {
    terminal_id: text().primaryKey(),
    session_id: text(),
    display_name: text().notNull(),
    role: text(),
    capabilities: text({ mode: "json" }).$type<string[]>().notNull(),
    status: text().notNull(),
    workspace_mode: text().notNull(),
    workspace_path: text(),
    task_id: text(),
    last_heartbeat_at: integer().notNull(),
  },
  (table) => [index("workmesh_terminal_session_status_heartbeat_idx").on(table.status, table.last_heartbeat_at)],
)

/** 项目本地终端消息，保存问题、最终答复及任务生命周期。 */
export const WorkMeshTerminalMessageTable = sqliteTable(
  "workmesh_terminal_message",
  {
    id: text().primaryKey(),
    sender_terminal_id: text().notNull(),
    recipient_terminal_id: text().notNull(),
    content: text().notNull(),
    execution: text({ mode: "json" }).$type<
      | { kind: "prompt"; agent: "build" | "plan" }
      | { kind: "command"; agent: "build" | "plan"; name: string; arguments: string }
    >(),
    status: text().notNull(),
    reply_to_message_id: text(),
    idempotency_key: text(),
    claimed_by_terminal_id: text(),
    result: text(),
    time_created: integer().notNull(),
    time_delivered: integer(),
    time_read: integer(),
    time_claimed: integer(),
    time_completed: integer(),
  },
  (table) => [
    uniqueIndex("workmesh_terminal_message_sender_idempotency_idx").on(table.sender_terminal_id, table.idempotency_key),
    index("workmesh_terminal_message_recipient_status_created_idx").on(
      table.recipient_terminal_id,
      table.status,
      table.time_created,
    ),
    index("workmesh_terminal_message_conversation_created_idx").on(
      table.sender_terminal_id,
      table.recipient_terminal_id,
      table.time_created,
    ),
  ],
)

/** 终端任务执行过程事件，保留接收终端实际展示的正文、工具、Shell 和状态输出。 */
export const WorkMeshTerminalMessageEventTable = sqliteTable(
  "workmesh_terminal_message_event",
  {
    cursor: integer().primaryKey({ autoIncrement: true }),
    id: text().notNull(),
    message_id: text()
      .notNull()
      .references(() => WorkMeshTerminalMessageTable.id, { onDelete: "cascade" }),
    terminal_id: text().notNull(),
    sequence: integer().notNull(),
    kind: text().notNull(),
    content: text().notNull(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    time_created: integer().notNull(),
    time_expires: integer().notNull(),
  },
  (table) => [
    uniqueIndex("workmesh_terminal_message_event_id_idx").on(table.id),
    uniqueIndex("workmesh_terminal_message_event_message_sequence_idx").on(table.message_id, table.sequence),
    index("workmesh_terminal_message_event_message_created_idx").on(table.message_id, table.time_created),
    index("workmesh_terminal_message_event_expires_idx").on(table.time_expires),
  ],
)

/** 远程投递待确认队列。Gateway 只中转，可靠投递状态始终保存在发送方项目数据库。 */
export const WorkMeshTerminalOutboxTable = sqliteTable(
  "workmesh_terminal_outbox",
  {
    delivery_id: text().primaryKey(),
    recipient_terminal_id: text().notNull(),
    envelope: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    attempts: integer().notNull(),
    time_created: integer().notNull(),
    time_next_attempt: integer().notNull(),
    time_acknowledged: integer(),
  },
  (table) => [index("workmesh_terminal_outbox_pending_idx").on(table.time_acknowledged, table.time_next_attempt)],
)

/** Agent 对项目文件或目录的本地读写意图。 */
export const WorkMeshTerminalIntentTable = sqliteTable(
  "workmesh_terminal_intent",
  {
    id: text().notNull(),
    terminal_id: text().notNull(),
    task_id: text(),
    path: text().notNull(),
    mode: text().notNull(),
    workspace_mode: text().notNull(),
    status: text().notNull(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.path] }),
    index("workmesh_terminal_intent_terminal_status_idx").on(table.terminal_id, table.status),
  ],
)
