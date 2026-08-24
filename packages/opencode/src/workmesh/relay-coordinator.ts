import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import type { CoordinatorMode, LocalCoordinator, TerminalMessage, TerminalSession } from "./coordinator"

type GatewayConfig = {
  baseUrl: string
  apiPrefix: string
  projectId: number
  token: string
}

type RelayEvent = {
  eventId: string
  type:
    | "message.created"
    | "message.processing"
    | "message.progress"
    | "message.completed"
    | "message.failed"
    | "message.acknowledged"
  projectId: number
  senderTerminalId: string
  recipientTerminalId?: string
  replyToEventId?: string
  status?: string
  content?: string
  execution?: TerminalMessage["execution"]
  delta?: string
  sequence?: number
  createdAt?: string
}

type OutboxRow = {
  delivery_id: string
  envelope: string
}

type MessageRouteRow = {
  id: string
  sender_terminal_id: string
  recipient_terminal_id: string
  status: TerminalMessage["status"]
}

const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 30_000
const RELAY_CONTENT_BYTES = 24 * 1024

export function gatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig | undefined {
  const baseUrl = (env.WORKMESH_GATEWAY_URL ?? "").trim().replace(/\/+$/, "")
  const projectId = Number(env.WORKMESH_GATEWAY_PROJECT_ID ?? "")
  const token = (env.WORKMESH_GATEWAY_TOKEN ?? "").trim()
  if (!baseUrl || !Number.isSafeInteger(projectId) || projectId <= 0 || !token) return
  try {
    const url = new URL(baseUrl)
    if (url.protocol !== "http:" && url.protocol !== "https:") return
  } catch {
    return
  }
  const configuredPrefix = (env.WORKMESH_GATEWAY_API_PREFIX ?? "").trim()
  const apiPrefix = configuredPrefix ? `/${configuredPrefix.replace(/^\/+|\/+$/g, "")}` : ""
  return { baseUrl, apiPrefix, projectId, token }
}

/**
 * 在本地 SQLite Coordinator 外叠加可选的远程实时 Relay。
 * 本机终端继续直接共享数据库；只有 Gateway 发现的远程终端才写 outbox 并经过 Redis 转发。
 */
export function createRelayCoordinator(
  local: LocalCoordinator,
  db: Database.Interface["db"],
  projectRoot: string,
  config: GatewayConfig,
): LocalCoordinator {
  const localTerminals = new Set<string>()
  const remoteTerminals = new Set<string>()
  const streams = new Map<string, AbortController>()
  let currentMode: CoordinatorMode = "online"
  let flushing = false

  const request = async (pathname: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set("Authorization", `Bearer ${config.token}`)
    if (init.body) headers.set("Content-Type", "application/json")
    let response: Response
    try {
      response = await fetch(`${config.baseUrl}${config.apiPrefix}${pathname}`, {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(4_000),
      })
    } catch (error) {
      currentMode = "degraded"
      throw new Error("Gateway Relay 连接失败", { cause: error })
    }
    const body = (await response.json().catch(() => undefined)) as unknown
    if (!response.ok || readString(body, "code") === "ERR") {
      currentMode = "degraded"
      throw new Error(readString(body, "message") || `Gateway HTTP ${response.status}`)
    }
    currentMode = "online"
    return readRecord(body, "data") ?? body
  }

  const publish = async (event: RelayEvent, persist = true) => {
    if (persist) await enqueueOutbox(db, event)
    try {
      await request("/workmesh/terminal/relay/publish", {
        method: "POST",
        body: JSON.stringify(event),
      })
      await markOutboxAttempt(db, event.eventId, true)
    } catch (error) {
      if (persist) await markOutboxAttempt(db, event.eventId, false)
      throw error
    }
  }

  const flushOutbox = async () => {
    if (flushing) return
    flushing = true
    try {
      const rows = await Effect.runPromise(
        db.all<OutboxRow>(sql`
        SELECT delivery_id, envelope
        FROM workmesh_terminal_outbox
        WHERE time_acknowledged IS NULL AND time_next_attempt <= ${Date.now()}
        ORDER BY time_created ASC
        LIMIT 50
      `),
      )
      for (const row of rows) {
        const event = parseRelayEvent(row.envelope)
        if (!event) {
          await Effect.runPromise(
            db.run(sql`DELETE FROM workmesh_terminal_outbox WHERE delivery_id = ${row.delivery_id}`),
          )
          continue
        }
        await publish(event, false).catch(() => undefined)
      }
    } finally {
      flushing = false
    }
  }

  const fetchRemoteTerminals = async () => {
    const data = await request(`/workmesh/terminal/index?projectId=${config.projectId}&page=1&pageSize=200`)
    const rows = readArray(data, "items")
    const localItems = await local.listAgents()
    const knownLocal = new Set(localItems.map((item) => item.terminalId))
    const mapped = rows.map(mapTerminal).filter((item) => item.terminalId)
    for (const item of mapped) {
      if (
        localTerminals.has(item.terminalId) ||
        (knownLocal.has(item.terminalId) && !remoteTerminals.has(item.terminalId))
      )
        continue
      remoteTerminals.add(item.terminalId)
      await local.register({
        terminalId: item.terminalId,
        sessionId: item.sessionId,
        displayName: item.displayName,
        role: item.role,
        capabilities: item.capabilities,
        status: item.status === "released" ? "offline" : item.status,
        workspaceMode: item.workspaceMode,
        workspacePath: item.workspacePath,
        taskId: item.taskId,
      })
    }
    return mapped
  }

  const acknowledgeRelay = (terminalId: string, event: RelayEvent) =>
    publish(
      {
        eventId: randomUUID(),
        type: "message.acknowledged",
        projectId: config.projectId,
        senderTerminalId: terminalId,
        recipientTerminalId: event.senderTerminalId,
        replyToEventId: event.eventId,
        createdAt: new Date().toISOString(),
      },
      false,
    ).catch(() => undefined)

  const ingest = async (terminalId: string, event: RelayEvent) => {
    if (event.senderTerminalId === terminalId) return
    if (event.type === "message.acknowledged") {
      if (event.replyToEventId) await acknowledgeOutbox(db, event.replyToEventId)
      return
    }
    remoteTerminals.add(event.senderTerminalId)
    if (!(await local.listAgents()).some((item) => item.terminalId === event.senderTerminalId)) {
      await local.register({
        terminalId: event.senderTerminalId,
        displayName: event.senderTerminalId,
        role: "remote",
        capabilities: ["message", "task"],
        status: "online",
        workspaceMode: "shared",
      })
    }
    await ingestRelayEvent(local, db, event)
    await acknowledgeRelay(terminalId, event)
  }

  const ensureStream = (terminalId: string) => {
    if (streams.has(terminalId)) return
    const controller = new AbortController()
    streams.set(terminalId, controller)
    void streamRelay(config, terminalId, controller.signal, (event) => ingest(terminalId, event)).finally(() =>
      streams.delete(terminalId),
    )
    const timer = setInterval(() => void flushOutbox(), 2_000)
    timer.unref?.()
    controller.signal.addEventListener("abort", () => clearInterval(timer), { once: true })
  }

  const messageRoute = (messageId: string) =>
    Effect.runPromise(
      db.get<MessageRouteRow>(
        sql`SELECT id, sender_terminal_id, recipient_terminal_id, status FROM workmesh_terminal_message WHERE id = ${messageId}`,
      ),
    )

  const publishLifecycle = async (
    terminalId: string,
    messageId: string,
    type: RelayEvent["type"],
    values: Partial<RelayEvent> = {},
  ) => {
    const row = await messageRoute(messageId)
    if (!row || !remoteTerminals.has(row.sender_terminal_id)) return
    await publish({
      eventId: randomUUID(),
      type,
      projectId: config.projectId,
      senderTerminalId: terminalId,
      recipientTerminalId: row.sender_terminal_id,
      replyToEventId: messageId,
      createdAt: new Date().toISOString(),
      ...values,
    }).catch(() => undefined)
  }

  const coordinator: LocalCoordinator = {
    ...local,
    register: async (input) => {
      const registered = await local.register(input)
      localTerminals.add(input.terminalId)
      remoteTerminals.delete(input.terminalId)
      ensureStream(input.terminalId)
      await request("/workmesh/terminal/register", {
        method: "POST",
        body: JSON.stringify({
          projectId: config.projectId,
          projectRoot,
          terminalId: input.terminalId,
          displayName: input.displayName,
          status: input.status,
          workspaceMode: input.workspaceMode,
          capabilities: Object.fromEntries(input.capabilities.map((item) => [item, true])),
        }),
      }).catch(() => undefined)
      await flushOutbox()
      return { ...registered, coordinatorMode: currentMode }
    },
    heartbeat: async (terminalId, status) => {
      const result = await local.heartbeat(terminalId, status)
      await request("/workmesh/terminal/heartbeat", {
        method: "POST",
        body: JSON.stringify({ projectId: config.projectId, terminalId, status }),
      }).catch(() => undefined)
      return { ...result, coordinatorMode: currentMode }
    },
    release: async (terminalId) => {
      await local.release(terminalId)
      streams.get(terminalId)?.abort()
      streams.delete(terminalId)
      await request("/workmesh/terminal/heartbeat", {
        method: "POST",
        body: JSON.stringify({ projectId: config.projectId, terminalId, status: "released" }),
      }).catch(() => undefined)
    },
    listAgents: async () => {
      const localItems = await local.listAgents()
      const remoteItems = await fetchRemoteTerminals().catch(() => [])
      const merged = new Map(localItems.map((item) => [item.terminalId, item]))
      for (const item of remoteItems) {
        if (localTerminals.has(item.terminalId)) continue
        merged.set(item.terminalId, item)
      }
      return [...merged.values()]
    },
    sendMessage: async (input) => {
      let agents = await local.listAgents()
      if (!agents.some((item) => item.terminalId === input.recipientTerminalId)) {
        await fetchRemoteTerminals().catch(() => undefined)
        agents = await local.listAgents()
      }
      const message = await local.sendMessage(input)
      if (!remoteTerminals.has(input.recipientTerminalId)) return message
      await publish({
        eventId: message.id,
        type: "message.created",
        projectId: config.projectId,
        senderTerminalId: input.senderTerminalId,
        recipientTerminalId: input.recipientTerminalId,
        replyToEventId: input.replyToMessageId,
        status: message.status,
        content: message.message,
        execution: message.execution,
        createdAt: message.createdAt,
      }).catch(() => undefined)
      return message
    },
    claimMessage: async (terminalId, messageId) => {
      const result = await local.claimMessage(terminalId, messageId)
      await publishLifecycle(terminalId, messageId, "message.processing", { status: result.status })
      return result
    },
    completeMessage: async (terminalId, messageId, result) => {
      const completed = await local.completeMessage(terminalId, messageId, result)
      await publishLifecycle(terminalId, messageId, "message.completed", {
        status: completed.status,
        content: clipRelay(result),
      })
      return completed
    },
    failMessage: async (terminalId, messageId, result) => {
      const failed = await local.failMessage(terminalId, messageId, result)
      await publishLifecycle(terminalId, messageId, "message.failed", {
        status: failed.status,
        content: clipRelay(result),
      })
      return failed
    },
    reportMessageEvent: async (input) => {
      const event = await local.reportMessageEvent(input)
      if (!event) return
      await publishLifecycle(input.terminalId, input.messageId, "message.progress", {
        status: input.kind,
        delta: clipRelay(input.content),
        content: clipRelay(input.content),
        sequence: input.sequence,
      })
      return event
    },
    mode: async () => currentMode,
  }
  return coordinator
}

async function ingestRelayEvent(local: LocalCoordinator, db: Database.Interface["db"], event: RelayEvent) {
  const messageId = event.type === "message.created" ? event.eventId : event.replyToEventId
  if (!messageId) return
  if (event.type === "message.created") {
    if (!event.recipientTerminalId || !event.content) return
    await Effect.runPromise(
      db.run(sql`
      INSERT OR IGNORE INTO workmesh_terminal_message (
        id, sender_terminal_id, recipient_terminal_id, content, execution, status, reply_to_message_id, time_created
      ) VALUES (
        ${event.eventId}, ${event.senderTerminalId}, ${event.recipientTerminalId}, ${event.content},
        ${event.execution ? JSON.stringify(event.execution) : null}, 'queued',
        ${event.replyToEventId ?? null}, ${parseTime(event.createdAt)}
      )
    `),
    )
    return
  }
  if (event.type === "message.processing") {
    await Effect.runPromise(
      db.run(sql`
      UPDATE workmesh_terminal_message
      SET status = 'processing', claimed_by_terminal_id = ${event.senderTerminalId}, time_claimed = ${Date.now()}
      WHERE id = ${messageId} AND status IN ('queued', 'delivered', 'processing')
    `),
    )
    return
  }
  if (event.type === "message.progress") {
    const row = await Effect.runPromise(
      db.get<MessageRouteRow>(sql`
      SELECT id, sender_terminal_id, recipient_terminal_id, status FROM workmesh_terminal_message WHERE id = ${messageId}
    `),
    )
    if (!row) return
    if (row.status !== "processing") {
      await Effect.runPromise(
        db.run(sql`
        UPDATE workmesh_terminal_message
        SET status = 'processing', claimed_by_terminal_id = ${event.senderTerminalId}, time_claimed = ${Date.now()}
        WHERE id = ${messageId}
      `),
      )
    }
    await local.reportMessageEvent({
      terminalId: row.recipient_terminal_id,
      messageId,
      sequence: Math.max(1, event.sequence ?? 1),
      kind: relayEventKind(event.status),
      content: event.delta ?? event.content ?? "",
      metadata: {},
    })
    return
  }
  const failed = event.type === "message.failed"
  await Effect.runPromise(
    db.run(sql`
    UPDATE workmesh_terminal_message
    SET status = ${failed ? "failed" : "completed"}, result = ${event.content ?? ""}, time_completed = ${Date.now()}
    WHERE id = ${messageId}
  `),
  )
}

async function enqueueOutbox(db: Database.Interface["db"], event: RelayEvent) {
  const now = Date.now()
  await Effect.runPromise(
    db.run(sql`
    INSERT OR IGNORE INTO workmesh_terminal_outbox (
      delivery_id, recipient_terminal_id, envelope, attempts, time_created, time_next_attempt
    ) VALUES (
      ${event.eventId}, ${event.recipientTerminalId ?? ""}, ${JSON.stringify(event)}, 0, ${now}, ${now}
    )
  `),
  )
}

async function markOutboxAttempt(db: Database.Interface["db"], deliveryId: string, published: boolean) {
  const row = await Effect.runPromise(
    db.get<{ attempts: number }>(sql`
    SELECT attempts FROM workmesh_terminal_outbox WHERE delivery_id = ${deliveryId}
  `),
  )
  if (!row) return
  const attempts = row.attempts + 1
  const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts, 5))
  await Effect.runPromise(
    db.run(sql`
    UPDATE workmesh_terminal_outbox
    SET attempts = ${attempts}, time_next_attempt = ${Date.now() + (published ? RETRY_MAX_MS : delay)}
    WHERE delivery_id = ${deliveryId}
  `),
  )
}

async function acknowledgeOutbox(db: Database.Interface["db"], deliveryId: string) {
  await Effect.runPromise(db.run(sql`DELETE FROM workmesh_terminal_outbox WHERE delivery_id = ${deliveryId}`))
}

async function streamRelay(
  config: GatewayConfig,
  terminalId: string,
  signal: AbortSignal,
  ingest: (event: RelayEvent) => Promise<void>,
) {
  let retry = 0
  while (!signal.aborted) {
    try {
      const query = new URLSearchParams({ projectId: String(config.projectId), terminalId })
      const response = await fetch(`${config.baseUrl}${config.apiPrefix}/workmesh/terminal/relay/stream?${query}`, {
        headers: { Authorization: `Bearer ${config.token}`, Accept: "text/event-stream" },
        signal,
      })
      if (!response.ok || !response.body) throw new Error(`Gateway Relay HTTP ${response.status}`)
      retry = 0
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      while (!signal.aborted) {
        const next = await reader.read()
        if (next.done) break
        buffer += decoder.decode(next.value, { stream: true })
        const records = buffer.split(/\r?\n\r?\n/)
        buffer = records.pop() ?? ""
        for (const record of records) {
          const data = record
            .split(/\r?\n/)
            .find((line) => line.startsWith("data:"))
            ?.slice(5)
            .trim()
          if (!data) continue
          const event = parseRelayEvent(data)
          if (event) await ingest(event)
        }
      }
    } catch {
      if (signal.aborted) return
    }
    retry += 1
    await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 500 * 2 ** Math.min(retry, 6))))
  }
}

function mapTerminal(value: unknown): TerminalSession {
  const capabilities = readRecord(value, "capabilities")
  const status = readString(value, "status")
  return {
    terminalId: readString(value, "terminalId"),
    projectRoot: readString(value, "projectRoot"),
    displayName: readString(value, "displayName") || "WorkMesh Agent",
    capabilities: capabilities ? Object.keys(capabilities).filter((key) => Boolean(capabilities[key])) : [],
    status: isTerminalStatus(status) ? status : "offline",
    workspaceMode:
      readString(value, "workspaceMode") === "locked"
        ? "locked"
        : readString(value, "workspaceMode") === "isolated"
          ? "isolated"
          : "shared",
    intents: [],
    lastHeartbeatAt: readString(value, "lastSeenAt") || new Date().toISOString(),
    coordinatorMode: "online",
  }
}

function parseRelayEvent(value: string): RelayEvent | undefined {
  try {
    const parsed = JSON.parse(value) as unknown
    const type = readString(parsed, "type")
    if (!isRelayType(type)) return
    const eventId = readString(parsed, "eventId")
    const senderTerminalId = readString(parsed, "senderTerminalId")
    const projectId = readNumber(parsed, "projectId")
    if (!eventId || !senderTerminalId || !projectId) return
    return {
      eventId,
      type,
      projectId,
      senderTerminalId,
      recipientTerminalId: readString(parsed, "recipientTerminalId") || undefined,
      replyToEventId: readString(parsed, "replyToEventId") || undefined,
      status: readString(parsed, "status") || undefined,
      content: readString(parsed, "content") || undefined,
      execution: parseRelayExecution(readRecord(parsed, "execution")),
      delta: readString(parsed, "delta") || undefined,
      sequence: readNumber(parsed, "sequence") || undefined,
      createdAt: readString(parsed, "createdAt") || undefined,
    }
  } catch {
    return
  }
}

function parseRelayExecution(value: Record<string, unknown> | undefined): TerminalMessage["execution"] {
  if (!value || (value.agent !== "build" && value.agent !== "plan")) return
  if (value.kind === "prompt") return { kind: "prompt", agent: value.agent }
  if (value.kind !== "command" || typeof value.name !== "string" || typeof value.arguments !== "string") return
  return { kind: "command", agent: value.agent, name: value.name, arguments: value.arguments }
}

function relayEventKind(value: string | undefined) {
  const allowed = [
    "assistant.text",
    "assistant.reasoning",
    "tool.input",
    "tool.output",
    "shell.output",
    "permission.asked",
    "permission.replied",
    "question.asked",
    "question.replied",
    "session.status",
    "session.error",
    "task.completed",
    "task.failed",
    "truncated",
  ] as const
  return allowed.find((item) => item === value) ?? "assistant.text"
}

function clipRelay(value: string) {
  if (Buffer.byteLength(value, "utf8") <= RELAY_CONTENT_BYTES) return value
  return Buffer.from(value, "utf8").subarray(0, RELAY_CONTENT_BYTES).toString("utf8")
}

function parseTime(value: string | undefined) {
  const parsed = value ? Date.parse(value) : Date.now()
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function isRelayType(value: string): value is RelayEvent["type"] {
  return [
    "message.created",
    "message.processing",
    "message.progress",
    "message.completed",
    "message.failed",
    "message.acknowledged",
  ].includes(value)
}

function isTerminalStatus(value: string): value is TerminalSession["status"] {
  return ["online", "busy", "away", "offline", "released"].includes(value)
}

function readRecord(value: unknown, key: string) {
  if (!value || typeof value !== "object") return
  const item = Reflect.get(value, key)
  return item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : undefined
}

function readArray(value: unknown, key: string) {
  if (!value || typeof value !== "object") return []
  const item = Reflect.get(value, key)
  return Array.isArray(item) ? (item as unknown[]) : []
}

function readString(value: unknown, key: string) {
  if (!value || typeof value !== "object") return ""
  const item = Reflect.get(value, key)
  return typeof item === "string" ? item : ""
}

function readNumber(value: unknown, key: string) {
  if (!value || typeof value !== "object") return 0
  const item = Number(Reflect.get(value, key))
  return Number.isFinite(item) ? item : 0
}
