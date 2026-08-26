import { EventV2Bridge } from "@/event-v2-bridge"
import { TuiEvent } from "@/server/tui-event"
import { Session } from "@/session/session"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { nextTuiRequest, submitTuiResponse } from "@/server/shared/tui-control"
import { InstanceHttpApi } from "../api"
import {
  CommandPayload,
  TuiPublishPayload,
  WorkMeshMessageActionPayload,
  WorkMeshMessageEventsQuery,
  WorkMeshMessageProgressPayload,
  WorkMeshMessagesQuery,
  WorkMeshTerminalQuery,
} from "../groups/tui"
import * as SessionError from "./session-errors"
import { InstanceState } from "@/effect/instance-state"
import { createWorkMeshCoordinator } from "@/workmesh/coordinator-service"
import { Database } from "@opencode-ai/core/database/database"
import { WorkMeshProduct } from "@/workmesh/product"
import type { WorkMeshMessagePayload } from "../groups/tui"
import { InvalidRequestError } from "../errors"
import type { SessionID } from "@/session/schema"

const commandAliases = {
  session_new: "session.new",
  session_share: "session.share",
  session_interrupt: "session.interrupt",
  session_compact: "session.compact",
  messages_page_up: "session.page.up",
  messages_page_down: "session.page.down",
  messages_line_up: "session.line.up",
  messages_line_down: "session.line.down",
  messages_half_page_up: "session.half.page.up",
  messages_half_page_down: "session.half.page.down",
  messages_first: "session.first",
  messages_last: "session.last",
  agent_cycle: "agent.cycle",
} as const

export const tuiHandlers = HttpApiBuilder.group(InstanceHttpApi, "tui", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const session = yield* Session.Service
    const { db } = yield* Database.Service
    const publishCommand = (command: typeof TuiEvent.CommandExecute.data.Type.command | undefined) =>
      events.publish(TuiEvent.CommandExecute, { command } as typeof TuiEvent.CommandExecute.data.Type)

    const appendPrompt = Effect.fn("TuiHttpApi.appendPrompt")(function* (ctx: {
      payload: typeof TuiEvent.PromptAppend.data.Type
    }) {
      yield* events.publish(TuiEvent.PromptAppend, ctx.payload)
      return true
    })

    const openHelp = Effect.fn("TuiHttpApi.openHelp")(function* () {
      yield* publishCommand("help.show")
      return true
    })

    const openSessions = Effect.fn("TuiHttpApi.openSessions")(function* () {
      yield* publishCommand("session.list")
      return true
    })

    const openThemes = Effect.fn("TuiHttpApi.openThemes")(function* () {
      yield* publishCommand("session.list")
      return true
    })

    const openModels = Effect.fn("TuiHttpApi.openModels")(function* () {
      yield* publishCommand("model.list")
      return true
    })

    const submitPrompt = Effect.fn("TuiHttpApi.submitPrompt")(function* () {
      yield* publishCommand("prompt.submit")
      return true
    })

    const clearPrompt = Effect.fn("TuiHttpApi.clearPrompt")(function* () {
      yield* publishCommand("prompt.clear")
      return true
    })

    const executeCommand = Effect.fn("TuiHttpApi.executeCommand")(function* (ctx: {
      payload: typeof CommandPayload.Type
    }) {
      // Legacy only publishes known aliases; unknown commands become undefined.
      yield* publishCommand(commandAliases[ctx.payload.command as keyof typeof commandAliases])
      return true
    })

    const showToast = Effect.fn("TuiHttpApi.showToast")(function* (ctx: {
      payload: typeof TuiEvent.ToastShow.data.Type
    }) {
      yield* events.publish(TuiEvent.ToastShow, ctx.payload)
      return true
    })

    const publish = Effect.fn("TuiHttpApi.publish")(function* (ctx: { payload: typeof TuiPublishPayload.Type }) {
      if (ctx.payload.type === TuiEvent.PromptAppend.type)
        yield* events.publish(TuiEvent.PromptAppend, ctx.payload.properties)
      if (ctx.payload.type === TuiEvent.CommandExecute.type)
        yield* events.publish(TuiEvent.CommandExecute, ctx.payload.properties)
      if (ctx.payload.type === TuiEvent.ToastShow.type)
        yield* events.publish(TuiEvent.ToastShow, ctx.payload.properties)
      if (ctx.payload.type === TuiEvent.SessionSelect.type)
        yield* events.publish(TuiEvent.SessionSelect, ctx.payload.properties)
      return true
    })

    const selectSession = Effect.fn("TuiHttpApi.selectSession")(function* (ctx: {
      payload: typeof TuiEvent.SessionSelect.data.Type
    }) {
      if (!ctx.payload.sessionID.startsWith("ses")) return yield* new HttpApiError.BadRequest({})
      yield* SessionError.mapStorageNotFound(session.get(ctx.payload.sessionID))
      yield* events.publish(TuiEvent.SessionSelect, ctx.payload)
      return true
    })

    const controlNext = Effect.fn("TuiHttpApi.controlNext")(function* () {
      return yield* Effect.promise(() => nextTuiRequest())
    })

    const controlResponse = Effect.fn("TuiHttpApi.controlResponse")(function* (ctx: { payload: unknown }) {
      submitTuiResponse(ctx.payload)
      return true
    })

    const coordinator = Effect.fn("TuiHttpApi.workmeshCoordinator")(function* () {
      const instance = yield* InstanceState.context
      return yield* Effect.promise(() =>
        createWorkMeshCoordinator(instance.worktree === "/" ? instance.directory : instance.worktree, db),
      )
    })

    const registerTerminal = Effect.fn("TuiHttpApi.registerTerminal")(function* (
      sessionID: SessionID,
      status?: "online" | "busy" | "away",
    ) {
      if (!WorkMeshProduct.enabled) {
        return yield* new InvalidRequestError({ message: "终端消息仅在 WorkMesh 模式可用。" })
      }
      const current = yield* SessionError.mapStorageNotFound(session.get(sessionID)).pipe(
        Effect.mapError(() => new InvalidRequestError({ message: "当前会话不存在，请先进入或创建会话。" })),
      )
      const service = yield* coordinator()
      const terminalId = `session:${sessionID}`
      const existing = yield* Effect.promise(() => service.listAgents())
      const effectiveStatus = status ?? existing.find((item) => item.terminalId === terminalId)?.status ?? "online"
      yield* Effect.promise(() =>
        service.register({
          terminalId,
          sessionId: sessionID,
          displayName: current.title || `WorkMesh ${sessionID.slice(-8)}`,
          role: "tui",
          capabilities: ["message", "task"],
          status: effectiveStatus === "released" || effectiveStatus === "offline" ? "online" : effectiveStatus,
          workspaceMode: "shared",
        }),
      )
      return { service, terminalId }
    })

    const workmeshTerminals = Effect.fn("TuiHttpApi.workmeshTerminals")(function* (ctx: {
      query: typeof WorkMeshTerminalQuery.Type
    }) {
      const current = yield* registerTerminal(ctx.query.sessionID, ctx.query.status)
      const items = (yield* Effect.promise(() => current.service.listAgents()))
        .filter(
          (item): item is typeof item & { status: Exclude<typeof item.status, "released"> } =>
            item.status !== "released",
        )
        .map((item) => ({
          terminalId: item.terminalId,
          displayName: item.displayName,
          role: item.role,
          status: item.status,
          workspaceMode: item.workspaceMode,
          current: item.terminalId === current.terminalId,
        }))
      return { currentTerminalId: current.terminalId, items }
    })

    const workmeshMessage = Effect.fn("TuiHttpApi.workmeshMessage")(function* (ctx: {
      payload: typeof WorkMeshMessagePayload.Type
    }) {
      const current = yield* registerTerminal(ctx.payload.sessionID)
      if (ctx.payload.recipientTerminalId === current.terminalId) {
        return yield* new InvalidRequestError({ message: "不能向当前终端发送消息。" })
      }
      const message = ctx.payload.message.trim()
      if (!message) return yield* new InvalidRequestError({ message: "消息不能为空。" })
      const sent = yield* Effect.tryPromise({
        try: () =>
          current.service.sendMessage({
            senderTerminalId: current.terminalId,
            recipientTerminalId: ctx.payload.recipientTerminalId,
            message,
            execution: ctx.payload.execution,
            replyToMessageId: ctx.payload.replyToMessageId,
            idempotencyKey: `tui:${ctx.payload.sessionID}:${Date.now()}`,
          }),
        catch: (error) => new InvalidRequestError({ message: error instanceof Error ? error.message : String(error) }),
      })
      return { id: sent.id, status: sent.status }
    })

    const workmeshMessages = Effect.fn("TuiHttpApi.workmeshMessages")(function* (ctx: {
      query: typeof WorkMeshMessagesQuery.Type
    }) {
      const current = yield* registerTerminal(ctx.query.sessionID, ctx.query.status)
      const peer = ctx.query.peerTerminalId
      const items = yield* Effect.promise(() => current.service.listConversation(current.terminalId, peer))
      return { items: items.map(toWorkMeshMessageItem) }
    })

    const workmeshMessageEvents = Effect.fn("TuiHttpApi.workmeshMessage.events")(function* (ctx: {
      query: typeof WorkMeshMessageEventsQuery.Type
    }) {
      if (!WorkMeshProduct.enabled) {
        return yield* new InvalidRequestError({ message: "终端消息仅在 WorkMesh 模式可用。" })
      }
      yield* SessionError.mapStorageNotFound(session.get(ctx.query.sessionID)).pipe(
        Effect.mapError(() => new InvalidRequestError({ message: "当前会话不存在，请先进入或创建会话。" })),
      )
      const service = yield* coordinator()
      return yield* Effect.tryPromise({
        try: () =>
          service.listMessageEvents(`session:${ctx.query.sessionID}`, ctx.query.peerTerminalId, {
            after: ctx.query.after,
            limit: ctx.query.limit,
          }),
        catch: (error) => new InvalidRequestError({ message: error instanceof Error ? error.message : String(error) }),
      })
    })

    const workmeshMessageAction = (action: "claim" | "complete" | "fail") =>
      Effect.fn(`TuiHttpApi.workmeshMessage.${action}`)(function* (ctx: {
        payload: typeof WorkMeshMessageActionPayload.Type
      }) {
        const current = yield* registerTerminal(ctx.payload.sessionID, ctx.payload.status)
        const result = ctx.payload.result ?? ""
        const item = yield* Effect.tryPromise({
          try: () =>
            action === "claim"
              ? current.service.claimMessage(current.terminalId, ctx.payload.messageId)
              : action === "complete"
                ? current.service.completeMessage(current.terminalId, ctx.payload.messageId, result)
                : current.service.failMessage(current.terminalId, ctx.payload.messageId, result),
          catch: (error) =>
            new InvalidRequestError({ message: error instanceof Error ? error.message : String(error) }),
        })
        return toWorkMeshMessageItem(item)
      })

    const workmeshMessageProgress = Effect.fn("TuiHttpApi.workmeshMessage.progress")(function* (ctx: {
      payload: typeof WorkMeshMessageProgressPayload.Type
    }) {
      if (!WorkMeshProduct.enabled) {
        return yield* new InvalidRequestError({ message: "终端消息仅在 WorkMesh 模式可用。" })
      }
      yield* SessionError.mapStorageNotFound(session.get(ctx.payload.sessionID)).pipe(
        Effect.mapError(() => new InvalidRequestError({ message: "当前会话不存在，请先进入或创建会话。" })),
      )
      const service = yield* coordinator()
      const terminalId = `session:${ctx.payload.sessionID}`
      yield* Effect.tryPromise({
        try: () =>
          service.reportMessageEvent({
            terminalId,
            messageId: ctx.payload.messageId,
            sequence: ctx.payload.sequence,
            kind: ctx.payload.kind ?? "assistant.text",
            content: ctx.payload.delta,
            metadata: ctx.payload.metadata,
          }),
        catch: (error) => new InvalidRequestError({ message: error instanceof Error ? error.message : String(error) }),
      })
      return true
    })

    return handlers
      .handle("appendPrompt", appendPrompt)
      .handle("openHelp", openHelp)
      .handle("openSessions", openSessions)
      .handle("openThemes", openThemes)
      .handle("openModels", openModels)
      .handle("submitPrompt", submitPrompt)
      .handle("clearPrompt", clearPrompt)
      .handle("executeCommand", executeCommand)
      .handle("showToast", showToast)
      .handle("publish", publish)
      .handle("selectSession", selectSession)
      .handle("controlNext", controlNext)
      .handle("controlResponse", controlResponse)
      .handle("workmeshTerminals", workmeshTerminals)
      .handle("workmeshMessage", workmeshMessage)
      .handle("workmeshMessages", workmeshMessages)
      .handle("workmeshMessageEvents", workmeshMessageEvents)
      .handle("workmeshMessageClaim", workmeshMessageAction("claim"))
      .handle("workmeshMessageComplete", workmeshMessageAction("complete"))
      .handle("workmeshMessageFail", workmeshMessageAction("fail"))
      .handle("workmeshMessageProgress", workmeshMessageProgress)
  }),
)

function toWorkMeshMessageItem(message: any) {
  return {
    id: message.id,
    senderTerminalId: message.senderTerminalId,
    recipientTerminalId: message.recipientTerminalId,
    message: message.message,
    ...(message.execution ? { execution: message.execution } : {}),
    status: message.status,
    ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
    createdAt: message.createdAt,
    ...(message.claimedByTerminalId ? { claimedByTerminalId: message.claimedByTerminalId } : {}),
    ...(message.claimedAt ? { claimedAt: message.claimedAt } : {}),
    ...(message.completedAt ? { completedAt: message.completedAt } : {}),
    ...(message.result ? { result: message.result } : {}),
  }
}
