import path from "node:path"
import { randomUUID } from "node:crypto"
import { readFile, realpath, rm } from "node:fs/promises"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import { WorkMeshRuntimeLayout } from "./runtime-layout"

export type CoordinatorMode = "online" | "degraded" | "offline"
export type WorkspaceMode = "shared" | "locked" | "isolated"
export type TerminalStatus = "online" | "busy" | "away" | "offline" | "released"

export type TerminalIntent = {
  id: string
  terminalId: string
  taskId?: string
  paths: string[]
  mode: "read" | "write"
  workspaceMode: WorkspaceMode
  status: "active" | "released" | "conflict"
  createdAt: string
  updatedAt: string
}

export type TerminalSession = {
  terminalId: string
  projectRoot: string
  sessionId?: string
  displayName: string
  role?: string
  capabilities: string[]
  status: TerminalStatus
  workspaceMode: WorkspaceMode
  workspacePath?: string
  taskId?: string
  intents: TerminalIntent[]
  lastHeartbeatAt: string
  coordinatorMode: CoordinatorMode
}

export type TerminalMessageExecution =
  | { kind: "prompt"; agent: "build" | "plan" }
  | { kind: "command"; agent: "build" | "plan"; name: string; arguments: string }

export type TerminalMessage = {
  id: string
  senderTerminalId: string
  recipientTerminalId: string
  message: string
  execution?: TerminalMessageExecution
  status: "queued" | "delivered" | "read" | "processing" | "completed" | "failed" | "expired"
  replyToMessageId?: string
  idempotencyKey?: string
  createdAt: string
  deliveredAt?: string
  readAt?: string
  claimedByTerminalId?: string
  claimedAt?: string
  completedAt?: string
  result?: string
}

export type TerminalMessageEventKind =
  | "assistant.text"
  | "assistant.reasoning"
  | "tool.input"
  | "tool.output"
  | "shell.output"
  | "permission.asked"
  | "permission.replied"
  | "question.asked"
  | "question.replied"
  | "session.status"
  | "session.error"
  | "task.completed"
  | "task.failed"
  | "truncated"

export type TerminalMessageEvent = {
  cursor: number
  id: string
  messageId: string
  terminalId: string
  sequence: number
  kind: TerminalMessageEventKind
  content: string
  metadata: Record<string, unknown>
  createdAt: string
}

type TerminalRow = {
  terminal_id: string
  session_id: string | null
  display_name: string
  role: string | null
  capabilities: string
  status: TerminalStatus
  workspace_mode: WorkspaceMode
  workspace_path: string | null
  task_id: string | null
  last_heartbeat_at: number
}

type IntentRow = {
  id: string
  terminal_id: string
  task_id: string | null
  path: string
  mode: "read" | "write"
  workspace_mode: WorkspaceMode
  status: TerminalIntent["status"]
  time_created: number
  time_updated: number
}

type MessageRow = {
  id: string
  sender_terminal_id: string
  recipient_terminal_id: string
  content: string
  execution: string | null
  status: TerminalMessage["status"]
  reply_to_message_id: string | null
  idempotency_key: string | null
  claimed_by_terminal_id: string | null
  result: string | null
  time_created: number
  time_delivered: number | null
  time_read: number | null
  time_claimed: number | null
  time_completed: number | null
}

type MessageEventRow = {
  cursor: number
  id: string
  message_id: string
  terminal_id: string
  sequence: number
  kind: TerminalMessageEventKind
  content: string
  metadata: string
  time_created: number
}

type LegacySnapshot = {
  version: 1
  projectRoot: string
  terminals: Record<string, TerminalSession>
  messages: Record<string, TerminalMessage>
}

const MAX_MESSAGE_BYTES = 8 * 1024
const MAX_EVENT_BYTES = 10 * 1024 * 1024
const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const STALE_MS = 30_000

export class CoordinatorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CoordinatorError"
  }
}

export type LocalCoordinator = {
  register(
    input: Omit<TerminalSession, "projectRoot" | "lastHeartbeatAt" | "coordinatorMode" | "intents"> & {
      intents?: TerminalIntent[]
    },
  ): Promise<TerminalSession>
  heartbeat(terminalId: string, status?: TerminalStatus): Promise<TerminalSession>
  release(terminalId: string): Promise<void>
  listAgents(): Promise<TerminalSession[]>
  sendMessage(input: {
    senderTerminalId: string
    recipientTerminalId: string
    message: string
    execution?: TerminalMessageExecution
    replyToMessageId?: string
    idempotencyKey?: string
  }): Promise<TerminalMessage>
  reportMessageEvent(input: {
    terminalId: string
    messageId: string
    sequence: number
    kind: TerminalMessageEventKind
    content: string
    metadata?: Record<string, unknown>
  }): Promise<TerminalMessageEvent | undefined>
  listMessageEvents(
    terminalId: string,
    peerTerminalId?: string,
    options?: { after?: number; limit?: number },
  ): Promise<{ items: TerminalMessageEvent[]; nextCursor: number }>
  listMessages(terminalId: string, options?: { unreadOnly?: boolean }): Promise<TerminalMessage[]>
  listConversation(terminalId: string, peerTerminalId?: string): Promise<TerminalMessage[]>
  claimMessage(terminalId: string, messageId: string): Promise<TerminalMessage>
  completeMessage(terminalId: string, messageId: string, result: string): Promise<TerminalMessage>
  failMessage(terminalId: string, messageId: string, result: string): Promise<TerminalMessage>
  acknowledgeMessage(terminalId: string, messageId: string): Promise<TerminalMessage>
  claimIntent(input: Omit<TerminalIntent, "id" | "createdAt" | "updatedAt" | "status">): Promise<TerminalIntent>
  releaseIntent(terminalId: string, intentId: string): Promise<void>
  mode(): Promise<CoordinatorMode>
}

export type Coordinator = LocalCoordinator

export async function createLocalCoordinator(
  projectRoot: string,
  db: Database.Interface["db"],
): Promise<LocalCoordinator> {
  // 调用方传入当前项目根，数据库由项目服务统一初始化，多个终端共享同一个 SQLite WAL。
  const root = await realpath(path.resolve(projectRoot))
  const legacyRoot = path.join(WorkMeshRuntimeLayout.layoutForRoot(root).root, "coordinator")
  await importLegacyCoordinator(db, root, legacyRoot)
  await Effect.runPromise(db.run(sql`DELETE FROM workmesh_terminal_message_event WHERE time_expires <= ${Date.now()}`))

  const requireAgent = async (terminalId: string) => {
    const row = await Effect.runPromise(
      db.get<TerminalRow>(sql`SELECT * FROM workmesh_terminal_session WHERE terminal_id = ${terminalId}`),
    )
    if (!row || row.status === "released") throw new CoordinatorError("终端 Agent 不存在或已退出")
    return row
  }

  const readMessage = async (messageId: string) => {
    const row = await Effect.runPromise(
      db.get<MessageRow>(sql`SELECT * FROM workmesh_terminal_message WHERE id = ${messageId}`),
    )
    if (!row) throw new CoordinatorError("消息不存在")
    return mapMessage(row)
  }

  const finishMessage = async (terminalId: string, messageId: string, result: string, failed: boolean) => {
    await requireAgent(terminalId)
    const now = Date.now()
    await Effect.runPromise(
      db.transaction((tx) =>
        Effect.gen(function* () {
          const row = yield* tx.get<MessageRow>(sql`SELECT * FROM workmesh_terminal_message WHERE id = ${messageId}`)
          if (!row || row.recipient_terminal_id !== terminalId)
            return yield* Effect.fail(new CoordinatorError("消息不存在或不属于当前终端"))
          if (row.status !== "processing" || row.claimed_by_terminal_id !== terminalId)
            return yield* Effect.fail(new CoordinatorError("消息尚未由当前终端领取"))
          yield* tx.run(sql`
            UPDATE workmesh_terminal_message
            SET status = ${failed ? "failed" : "completed"}, result = ${result}, time_completed = ${now}
            WHERE id = ${messageId}
          `)
        }),
      ),
    )
    return readMessage(messageId)
  }

  return {
    register: async (input) => {
      if (!input.terminalId.trim()) throw new CoordinatorError("终端 Agent ID 不能为空")
      const now = Date.now()
      await Effect.runPromise(
        db.run(sql`
        INSERT INTO workmesh_terminal_session (
          terminal_id, session_id, display_name, role, capabilities, status, workspace_mode,
          workspace_path, task_id, last_heartbeat_at
        ) VALUES (
          ${input.terminalId}, ${input.sessionId ?? null}, ${input.displayName}, ${input.role ?? null},
          ${JSON.stringify(input.capabilities)}, ${input.status === "released" ? "online" : input.status},
          ${input.workspaceMode}, ${input.workspacePath ?? null}, ${input.taskId ?? null}, ${now}
        )
        ON CONFLICT(terminal_id) DO UPDATE SET
          session_id = excluded.session_id,
          display_name = excluded.display_name,
          role = excluded.role,
          capabilities = excluded.capabilities,
          status = excluded.status,
          workspace_mode = excluded.workspace_mode,
          workspace_path = excluded.workspace_path,
          task_id = excluded.task_id,
          last_heartbeat_at = excluded.last_heartbeat_at
      `),
      )
      if (input.intents) {
        for (const intent of input.intents) await insertIntent(db, intent)
      }
      return (await listTerminals(db, root)).find((item) => item.terminalId === input.terminalId)!
    },
    heartbeat: async (terminalId, status = "online") => {
      await requireAgent(terminalId)
      await Effect.runPromise(
        db.run(
          sql`UPDATE workmesh_terminal_session SET status = ${status}, last_heartbeat_at = ${Date.now()} WHERE terminal_id = ${terminalId}`,
        ),
      )
      return (await listTerminals(db, root)).find((item) => item.terminalId === terminalId)!
    },
    release: async (terminalId) => {
      await requireAgent(terminalId)
      await Effect.runPromise(
        db.run(
          sql`UPDATE workmesh_terminal_session SET status = 'released', last_heartbeat_at = ${Date.now()} WHERE terminal_id = ${terminalId}`,
        ),
      )
    },
    listAgents: async () => {
      await Effect.runPromise(
        db.run(sql`
        UPDATE workmesh_terminal_session
        SET status = 'offline'
        WHERE status NOT IN ('released', 'offline') AND last_heartbeat_at < ${Date.now() - STALE_MS}
      `),
      )
      return listTerminals(db, root)
    },
    sendMessage: async (input) => {
      await requireAgent(input.senderTerminalId)
      await requireAgent(input.recipientTerminalId)
      const message = input.message.trim()
      if (!message) throw new CoordinatorError("消息不能为空")
      if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES) throw new CoordinatorError("消息超过 8 KiB 限制")
      if (input.idempotencyKey) {
        const previous = await Effect.runPromise(
          db.get<MessageRow>(sql`
          SELECT * FROM workmesh_terminal_message
          WHERE sender_terminal_id = ${input.senderTerminalId} AND idempotency_key = ${input.idempotencyKey}
        `),
        )
        if (previous) return mapMessage(previous)
      }
      const id = randomUUID()
      await Effect.runPromise(
        db.run(sql`
        INSERT INTO workmesh_terminal_message (
          id, sender_terminal_id, recipient_terminal_id, content, execution, status, reply_to_message_id,
          idempotency_key, time_created
        ) VALUES (
          ${id}, ${input.senderTerminalId}, ${input.recipientTerminalId}, ${message},
          ${input.execution ? JSON.stringify(input.execution) : null}, 'queued',
          ${input.replyToMessageId ?? null}, ${input.idempotencyKey ?? null}, ${Date.now()}
        )
      `),
      )
      return readMessage(id)
    },
    reportMessageEvent: (input) => writeMessageEvent(db, { ...input, metadata: input.metadata ?? {} }),
    listMessageEvents: async (terminalId, peerTerminalId, options = {}) => {
      const after = Math.max(0, options.after ?? 0)
      const limit = Math.min(500, Math.max(1, options.limit ?? 200))
      const rows = await Effect.runPromise(
        db.all<MessageEventRow>(sql`
        SELECT event.cursor, event.id, event.message_id, event.terminal_id, event.sequence,
               event.kind, event.content, event.metadata, event.time_created
        FROM workmesh_terminal_message_event AS event
        INNER JOIN workmesh_terminal_message AS message ON message.id = event.message_id
        WHERE event.cursor > ${after}
          AND (message.sender_terminal_id = ${terminalId} OR message.recipient_terminal_id = ${terminalId})
          AND (${peerTerminalId ?? null} IS NULL OR message.sender_terminal_id = ${peerTerminalId ?? null}
               OR message.recipient_terminal_id = ${peerTerminalId ?? null})
        ORDER BY event.cursor ASC
        LIMIT ${limit}
      `),
      )
      const items = rows.map(mapMessageEvent)
      return { items, nextCursor: items.at(-1)?.cursor ?? after }
    },
    listMessages: async (terminalId, options = {}) => {
      const rows = await Effect.runPromise(
        db.all<MessageRow>(sql`
        SELECT * FROM workmesh_terminal_message
        WHERE recipient_terminal_id = ${terminalId}
          AND (${options.unreadOnly ? 1 : 0} = 0 OR status != 'read')
        ORDER BY time_created ASC
      `),
      )
      return rows.map(mapMessage)
    },
    listConversation: async (terminalId, peerTerminalId) => {
      const rows = await Effect.runPromise(
        db.all<MessageRow>(sql`
        SELECT * FROM workmesh_terminal_message
        WHERE (sender_terminal_id = ${terminalId} OR recipient_terminal_id = ${terminalId})
          AND (${peerTerminalId ?? null} IS NULL OR sender_terminal_id = ${peerTerminalId ?? null}
               OR recipient_terminal_id = ${peerTerminalId ?? null})
        ORDER BY time_created ASC
      `),
      )
      return rows.map(mapMessage)
    },
    claimMessage: async (terminalId, messageId) => {
      await requireAgent(terminalId)
      const now = Date.now()
      await Effect.runPromise(
        db.transaction((tx) =>
          Effect.gen(function* () {
            const row = yield* tx.get<MessageRow>(sql`SELECT * FROM workmesh_terminal_message WHERE id = ${messageId}`)
            if (!row || row.recipient_terminal_id !== terminalId)
              return yield* Effect.fail(new CoordinatorError("消息不存在或不属于当前终端"))
            if (row.status !== "queued" && row.status !== "delivered")
              return yield* Effect.fail(new CoordinatorError("消息已被领取或已结束"))
            yield* tx.run(sql`
          UPDATE workmesh_terminal_message
          SET status = 'processing', time_delivered = ${now}, claimed_by_terminal_id = ${terminalId}, time_claimed = ${now}
          WHERE id = ${messageId}
        `)
          }),
        ),
      )
      return readMessage(messageId)
    },
    completeMessage: (terminalId, messageId, result) => finishMessage(terminalId, messageId, result, false),
    failMessage: (terminalId, messageId, result) => finishMessage(terminalId, messageId, result, true),
    acknowledgeMessage: async (terminalId, messageId) => {
      await requireAgent(terminalId)
      const current = await readMessage(messageId)
      if (current.recipientTerminalId !== terminalId) throw new CoordinatorError("消息不存在或不属于当前终端")
      await Effect.runPromise(
        db.run(
          sql`UPDATE workmesh_terminal_message SET status = 'read', time_read = ${Date.now()} WHERE id = ${messageId}`,
        ),
      )
      return readMessage(messageId)
    },
    claimIntent: async (input) => {
      await requireAgent(input.terminalId)
      const paths = input.paths.map((item) => normalizeIntentPath(root, item))
      if (paths.length === 0) throw new CoordinatorError("文件意图至少需要一个路径")
      const active = await Effect.runPromise(
        db.all<IntentRow>(sql`
        SELECT * FROM workmesh_terminal_intent
        WHERE status = 'active' AND mode = 'write' AND terminal_id != ${input.terminalId}
      `),
      )
      const conflict =
        input.mode === "write" && active.some((intent) => paths.some((candidate) => overlaps(intent.path, candidate)))
      const now = new Date().toISOString()
      const intent: TerminalIntent = {
        ...input,
        paths,
        id: randomUUID(),
        status: conflict ? "conflict" : "active",
        createdAt: now,
        updatedAt: now,
      }
      await insertIntent(db, intent)
      return intent
    },
    releaseIntent: async (terminalId, intentId) => {
      await requireAgent(terminalId)
      const intent = await Effect.runPromise(
        db.get<IntentRow>(sql`
        SELECT * FROM workmesh_terminal_intent WHERE id = ${intentId} AND terminal_id = ${terminalId} LIMIT 1
      `),
      )
      if (!intent) throw new CoordinatorError("文件意图不存在")
      await Effect.runPromise(
        db.run(sql`
        UPDATE workmesh_terminal_intent SET status = 'released', time_updated = ${Date.now()}
        WHERE id = ${intentId} AND terminal_id = ${terminalId}
      `),
      )
    },
    mode: async () => "offline",
  }
}

async function listTerminals(db: Database.Interface["db"], root: string) {
  const [terminals, intents] = await Promise.all([
    Effect.runPromise(db.all<TerminalRow>(sql`SELECT * FROM workmesh_terminal_session ORDER BY display_name ASC`)),
    Effect.runPromise(
      db.all<IntentRow>(sql`SELECT * FROM workmesh_terminal_intent ORDER BY time_created ASC, path ASC`),
    ),
  ])
  return terminals.map(
    (terminal): TerminalSession => ({
      terminalId: terminal.terminal_id,
      projectRoot: root,
      sessionId: terminal.session_id ?? undefined,
      displayName: terminal.display_name,
      role: terminal.role ?? undefined,
      capabilities: parseJSON<string[]>(terminal.capabilities, []),
      status: terminal.status,
      workspaceMode: terminal.workspace_mode,
      workspacePath: terminal.workspace_path ?? undefined,
      taskId: terminal.task_id ?? undefined,
      intents: groupIntents(intents.filter((intent) => intent.terminal_id === terminal.terminal_id)),
      lastHeartbeatAt: new Date(terminal.last_heartbeat_at).toISOString(),
      coordinatorMode: "offline",
    }),
  )
}

async function insertIntent(db: Database.Interface["db"], intent: TerminalIntent) {
  const created = Date.parse(intent.createdAt)
  const updated = Date.parse(intent.updatedAt)
  await Effect.runPromise(
    db.transaction((tx) =>
      Effect.forEach(
        intent.paths,
        (item) =>
          tx.run(sql`
    INSERT OR REPLACE INTO workmesh_terminal_intent (
      id, terminal_id, task_id, path, mode, workspace_mode, status, time_created, time_updated
    ) VALUES (
      ${intent.id}, ${intent.terminalId}, ${intent.taskId ?? null}, ${item}, ${intent.mode},
      ${intent.workspaceMode}, ${intent.status}, ${created}, ${updated}
    )
  `),
        { discard: true },
      ),
    ),
  )
}

async function writeMessageEvent(
  db: Database.Interface["db"],
  input: {
    terminalId: string
    messageId: string
    sequence: number
    kind: TerminalMessageEventKind
    content: string
    metadata: Record<string, unknown>
  },
) {
  const now = Date.now()
  const result = await Effect.runPromise(
    db.transaction((tx) =>
      Effect.gen(function* () {
        const message = yield* tx.get<MessageRow>(
          sql`SELECT * FROM workmesh_terminal_message WHERE id = ${input.messageId}`,
        )
        if (!message || message.recipient_terminal_id !== input.terminalId)
          return yield* Effect.fail(new CoordinatorError("消息不存在或不属于当前终端"))
        if (message.status !== "processing")
          return yield* Effect.fail(new CoordinatorError("只能为执行中的消息写入过程事件"))
        const existing = yield* tx.get<MessageEventRow>(sql`
      SELECT * FROM workmesh_terminal_message_event
      WHERE message_id = ${input.messageId} AND sequence = ${input.sequence}
    `)
        if (existing) return mapMessageEvent(existing)
        const total = yield* tx.get<{ size: number }>(sql`
      SELECT COALESCE(SUM(length(CAST(content AS BLOB))), 0) AS size
      FROM workmesh_terminal_message_event WHERE message_id = ${input.messageId}
    `)
        if ((total?.size ?? 0) >= MAX_EVENT_BYTES) {
          const truncated = yield* tx.get<MessageEventRow>(sql`
        SELECT * FROM workmesh_terminal_message_event WHERE message_id = ${input.messageId} AND kind = 'truncated'
      `)
          if (truncated) return undefined
          yield* tx.run(sql`
        INSERT INTO workmesh_terminal_message_event (
          id, message_id, terminal_id, sequence, kind, content, metadata, time_created, time_expires
        ) VALUES (
          ${randomUUID()}, ${input.messageId}, ${input.terminalId}, ${input.sequence}, 'truncated',
          '任务过程输出超过 10 MiB，后续内容未保存。', '{}', ${now}, ${now + EVENT_RETENTION_MS}
        )
      `)
        } else {
          yield* tx.run(sql`
        INSERT INTO workmesh_terminal_message_event (
          id, message_id, terminal_id, sequence, kind, content, metadata, time_created, time_expires
        ) VALUES (
          ${randomUUID()}, ${input.messageId}, ${input.terminalId}, ${input.sequence}, ${input.kind},
          ${clipUTF8(input.content, MAX_EVENT_BYTES - (total?.size ?? 0))}, ${JSON.stringify(input.metadata)},
          ${now}, ${now + EVENT_RETENTION_MS}
        )
      `)
        }
        const row = yield* tx.get<MessageEventRow>(sql`
      SELECT * FROM workmesh_terminal_message_event
      WHERE message_id = ${input.messageId} AND sequence = ${input.sequence}
    `)
        return row ? mapMessageEvent(row) : undefined
      }),
    ),
  )
  return result
}

function mapMessage(row: MessageRow): TerminalMessage {
  return {
    id: row.id,
    senderTerminalId: row.sender_terminal_id,
    recipientTerminalId: row.recipient_terminal_id,
    message: row.content,
    execution: parseExecution(row.execution),
    status: row.status,
    replyToMessageId: row.reply_to_message_id ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    createdAt: new Date(row.time_created).toISOString(),
    deliveredAt: toISO(row.time_delivered),
    readAt: toISO(row.time_read),
    claimedByTerminalId: row.claimed_by_terminal_id ?? undefined,
    claimedAt: toISO(row.time_claimed),
    completedAt: toISO(row.time_completed),
    result: row.result ?? undefined,
  }
}

function mapMessageEvent(row: MessageEventRow): TerminalMessageEvent {
  return {
    cursor: row.cursor,
    id: row.id,
    messageId: row.message_id,
    terminalId: row.terminal_id,
    sequence: row.sequence,
    kind: row.kind,
    content: row.content,
    metadata: parseJSON(row.metadata, {}),
    createdAt: new Date(row.time_created).toISOString(),
  }
}

function groupIntents(rows: IntentRow[]) {
  const grouped = new Map<string, TerminalIntent>()
  for (const row of rows) {
    const existing = grouped.get(row.id)
    if (existing) {
      existing.paths.push(row.path)
      continue
    }
    grouped.set(row.id, {
      id: row.id,
      terminalId: row.terminal_id,
      taskId: row.task_id ?? undefined,
      paths: [row.path],
      mode: row.mode,
      workspaceMode: row.workspace_mode,
      status: row.status,
      createdAt: new Date(row.time_created).toISOString(),
      updatedAt: new Date(row.time_updated).toISOString(),
    })
  }
  return [...grouped.values()]
}

async function importLegacyCoordinator(db: Database.Interface["db"], root: string, legacyRoot: string) {
  const snapshot =
    (await readLegacySnapshot(path.join(legacyRoot, "snapshot.json"))) ??
    (await readLegacySnapshot(path.join(legacyRoot, "snapshot.backup.json")))
  if (!snapshot || snapshot.version !== 1 || path.resolve(snapshot.projectRoot) !== root) return
  await Effect.runPromise(
    db.transaction((tx) =>
      Effect.gen(function* () {
        for (const terminal of Object.values(snapshot.terminals)) {
          yield* tx.run(sql`
        INSERT OR IGNORE INTO workmesh_terminal_session (
          terminal_id, session_id, display_name, role, capabilities, status, workspace_mode,
          workspace_path, task_id, last_heartbeat_at
        ) VALUES (
          ${terminal.terminalId}, ${terminal.sessionId ?? null}, ${terminal.displayName}, ${terminal.role ?? null},
          ${JSON.stringify(terminal.capabilities)}, ${terminal.status}, ${terminal.workspaceMode},
          ${terminal.workspacePath ?? null}, ${terminal.taskId ?? null}, ${Date.parse(terminal.lastHeartbeatAt)}
        )
      `)
          for (const intent of terminal.intents) {
            for (const item of intent.paths)
              yield* tx.run(sql`
          INSERT OR IGNORE INTO workmesh_terminal_intent (
            id, terminal_id, task_id, path, mode, workspace_mode, status, time_created, time_updated
          ) VALUES (
            ${intent.id}, ${intent.terminalId}, ${intent.taskId ?? null}, ${item}, ${intent.mode},
            ${intent.workspaceMode}, ${intent.status}, ${Date.parse(intent.createdAt)}, ${Date.parse(intent.updatedAt)}
          )
        `)
          }
        }
        for (const message of Object.values(snapshot.messages))
          yield* tx.run(sql`
      INSERT OR IGNORE INTO workmesh_terminal_message (
        id, sender_terminal_id, recipient_terminal_id, content, status, reply_to_message_id,
        idempotency_key, claimed_by_terminal_id, result, time_created, time_delivered, time_read,
        time_claimed, time_completed
      ) VALUES (
        ${message.id}, ${message.senderTerminalId}, ${message.recipientTerminalId}, ${message.message},
        ${message.status}, ${message.replyToMessageId ?? null}, ${message.idempotencyKey ?? null},
        ${message.claimedByTerminalId ?? null}, ${message.result ?? null}, ${Date.parse(message.createdAt)},
        ${parseTime(message.deliveredAt)}, ${parseTime(message.readAt)}, ${parseTime(message.claimedAt)},
        ${parseTime(message.completedAt)}
      )
    `)
      }),
    ),
  )
  // SQLite 提交成功后旧目录不再是权威来源，直接移除以避免形成双存储。
  await rm(legacyRoot, { recursive: true, force: true })
}

async function readLegacySnapshot(file: string) {
  try {
    return JSON.parse(await readFile(file, "utf8")) as LegacySnapshot
  } catch {
    return undefined
  }
}

function normalizeIntentPath(projectRoot: string, value: string) {
  const resolved = path.resolve(projectRoot, value)
  const relative = path.relative(projectRoot, resolved).replaceAll("\\", "/")
  if (!relative || relative === ".") return "."
  if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative))
    throw new CoordinatorError(`文件意图超出当前项目：${value}`)
  return relative.replace(/^\.\//, "").replace(/\/$/, "")
}

function overlaps(left: string, right: string) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

function clipUTF8(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
  const suffix = "\n[输出达到任务保存上限，内容已截断]"
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"))
  return Buffer.from(value, "utf8").subarray(0, budget).toString("utf8") + suffix
}

function parseJSON<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function parseExecution(value: string | null): TerminalMessageExecution | undefined {
  if (!value) return
  const parsed = parseJSON<unknown>(value, undefined)
  if (!parsed || typeof parsed !== "object") return
  const execution = parsed as Record<string, unknown>
  if (execution.agent !== "build" && execution.agent !== "plan") return
  if (execution.kind === "prompt") return { kind: "prompt", agent: execution.agent }
  if (execution.kind !== "command" || typeof execution.name !== "string" || typeof execution.arguments !== "string")
    return
  return {
    kind: "command",
    agent: execution.agent,
    name: execution.name,
    arguments: execution.arguments,
  }
}

function toISO(value: number | null) {
  return value == null ? undefined : new Date(value).toISOString()
}

function parseTime(value: string | undefined) {
  return value ? Date.parse(value) : null
}
