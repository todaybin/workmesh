import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import os from "os"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { SessionRevert } from "./revert"
import { Session } from "./session"
import { Agent } from "../agent/agent"
import { Provider } from "@/provider/provider"

import { type Tool as AITool, tool, jsonSchema } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { SessionCompaction } from "./compaction"
import { SystemPrompt } from "./system"
import { Instruction } from "./instruction"
import { Plugin } from "../plugin"
import { MAX_STEPS_PROMPT } from "@opencode-ai/core/session/runner/max-steps"
import { ToolRegistry } from "@/tool/registry"
import { MCP } from "../mcp"
import { LSP } from "@/lsp/lsp"
import { ulid } from "ulid"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as Stream from "effect/Stream"
import { Command } from "../command"
import { pathToFileURL, fileURLToPath } from "url"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { SessionSummary } from "./summary"
import { NamedError } from "@opencode-ai/core/util/error"
import { SessionProcessor } from "./processor"
import { Tool } from "@/tool/tool"
import { Permission } from "@/permission"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { Shell } from "@opencode-ai/core/shell"
import { ShellID } from "@/tool/shell/id"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Image } from "@/image/image"
import { decodeDataUrl } from "@/util/data-url"
import { Process } from "@/util/process"
import { Cause, Effect, Exit, Latch, Layer, Option, Scope, Context, Schema, Types } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { SessionRunState } from "./run-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { eq } from "drizzle-orm"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionReminders } from "./reminders"
import { SessionGoal } from "./goal"
import { WorkMeshLoops } from "./loops"
import { SessionTools } from "./tools"
import { LLMEvent } from "@opencode-ai/llm"
import { WorkMeshProduct } from "@/workmesh/product"
import { WorkMeshLanguage } from "@/workmesh/language"
import { WorkMeshCommandLocale } from "@/workmesh/command-locale"
import { createWorkMeshCoordinator } from "@/workmesh/coordinator-service"
import { createComposeService, type ExecutionLease } from "@/compose/runtime"
import { executeGitFinish } from "@/compose/git-finish"
import { Compose } from "@opencode-ai/schema/compose"
import { ComposeEvent } from "@opencode-ai/schema/compose-event"
import { errorMessage } from "@/util/error"
import { createComposeWorkspace, removeComposeWorkspace } from "@/compose/workspace"
import { ComposePermission } from "@/workmesh/compose-permission"
import {
  applyComposeTaskChanges,
  createComposeTaskWorkspace,
  removeComposeTaskWorkspaces,
} from "@/compose/task-workspace"
import type { TaskWorkspace } from "@/compose/task-workspace"
import {
  approveComposeSpec,
  discardTemporaryApprovedSpec,
  verifyApprovedComposeSpec,
  writeComposeSpecDraft,
} from "@/compose/spec-artifact"
import { mkdir } from "node:fs/promises"
import { captureComposeWorkingSnapshot } from "@/compose/working-snapshot"
import { composeWorktreeDigest } from "@/compose/worktree-digest"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

const decodeMessageInfo = Schema.decodeUnknownExit(SessionV1.Info)
const decodeMessagePart = Schema.decodeUnknownExit(SessionV1.Part)
const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])
const MAX_GOAL_REACT = 12
const COMPOSE_AGENTS = new Set(["compose", "compose-execute", "compose-review"])
const COMPOSE_SPEC_READY = "<!-- workmesh-compose:spec-ready -->"
const ComposeInternal = Context.Reference<boolean>("~workmesh/ComposeInternal", { defaultValue: () => false })

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

function mcpResourceBase64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

function formatMcpResourceBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

function isOrphanedInterruptedTool(part: SessionV1.ToolPart) {
  // cleanup() marks abandoned tool_use blocks this way after retries/aborts.
  // They are not pending work and must not trigger an assistant-prefill request.
  return part.state.status === "error" && part.state.metadata?.interrupted === true
}

function composeSpecReady(message: SessionV1.WithParts) {
  return message.parts.some((part) => part.type === "text" && part.text.includes(COMPOSE_SPEC_READY))
}

function composeSpecText(message: SessionV1.WithParts) {
  return message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text.replaceAll(COMPOSE_SPEC_READY, "").trim())
    .filter(Boolean)
    .join("\n\n")
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly prompt: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error>
  readonly loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts>
  readonly shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
  readonly command: (input: CommandInput) => Effect.Effect<SessionV1.WithParts, Image.Error>
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPrompt") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const processor = yield* SessionProcessor.Service
    const compaction = yield* SessionCompaction.Service
    const plugin = yield* Plugin.Service
    const commands = yield* Command.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const fsys = yield* FSUtil.Service
    const mcp = yield* MCP.Service
    const lsp = yield* LSP.Service
    const registry = yield* ToolRegistry.Service
    const truncate = yield* Truncate.Service
    const image = yield* Image.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Scope.Scope
    const instruction = yield* Instruction.Service
    const state = yield* SessionRunState.Service
    const revert = yield* SessionRevert.Service
    const summary = yield* SessionSummary.Service
    const sys = yield* SystemPrompt.Service
    const llm = yield* LLM.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const goal = yield* SessionGoal.Service
    const loops = yield* WorkMeshLoops.Service
    const workmeshLanguage = yield* WorkMeshLanguage.Service
    const database = yield* Database.Service
    const { db } = database
    const schedulerState = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        return { scope: yield* Scope.Scope, started: false }
      }),
    )
    const ops = Effect.fn("SessionPrompt.ops")(function* () {
      return {
        cancel: (sessionID: SessionID) => cancel(sessionID),
        resolvePromptParts: (template: string) => resolvePromptParts(template),
        prompt: (input: PromptInput) => prompt(input).pipe(Effect.catch(Effect.die)),
      } satisfies TaskPromptOps
    })

    const cancel = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID) {
      yield* Effect.logInfo("cancel", { "session.id": sessionID })
      yield* state.cancel(sessionID)
    })

    const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
      const ctx = yield* InstanceState.context
      const parts: Types.DeepMutable<PromptInput["parts"]> = [{ type: "text", text: template }]
      const files = ConfigMarkdown.files(template)
      const seen = new Set<string>()
      yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (match) {
          const name = match[1]
          if (!name) return
          if (seen.has(name)) return
          seen.add(name)

          const filepath = name.startsWith("~/")
            ? path.join(os.homedir(), name.slice(2))
            : path.resolve(ctx.worktree, name)

          const info = yield* fsys.stat(filepath).pipe(Effect.option)
          if (Option.isNone(info)) {
            const found = yield* agents.get(name)
            if (found) parts.push({ type: "agent", name: found.name })
            return
          }
          const stat = info.value
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: stat.type === "Directory" ? "application/x-directory" : "text/plain",
          })
        }),
        { concurrency: "unbounded", discard: true },
      )
      return parts
    })

    const title = Effect.fn("SessionPrompt.ensureTitle")(function* (input: {
      session: Session.Info
      history: SessionV1.WithParts[]
      providerID: ProviderV2.ID
      modelID: ModelV2.ID
    }) {
      if (input.session.parentID) return
      if (!Session.isDefaultTitle(input.session.title)) return

      const real = (m: SessionV1.WithParts) =>
        m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)
      const idx = input.history.findIndex(real)
      if (idx === -1) return
      if (input.history.filter(real).length !== 1) return

      const context = input.history.slice(0, idx + 1)
      const firstUser = context[idx]
      if (!firstUser || firstUser.info.role !== "user") return
      const firstInfo = firstUser.info

      const subtasks = firstUser.parts.filter((p): p is SessionV1.SubtaskPart => p.type === "subtask")
      const onlySubtasks = subtasks.length > 0 && firstUser.parts.every((p) => p.type === "subtask")

      const ag = yield* agents.get("title")
      if (!ag) return
      const mdl = ag.model
        ? yield* provider.getModel(ag.model.providerID, ag.model.modelID)
        : ((yield* provider.getSmallModel(input.providerID)) ??
          (yield* provider.getModel(input.providerID, input.modelID)))
      const msgs = onlySubtasks
        ? [{ role: "user" as const, content: subtasks.map((p) => p.prompt).join("\n") }]
        : yield* MessageV2.toModelMessagesEffect(context, mdl)
      const language = yield* workmeshLanguage.get()
      const locale = WorkMeshCommandLocale.resolve(language)
      const text = yield* llm
        .stream({
          agent: ag,
          user: firstInfo,
          system: WorkMeshProduct.enabled ? [WorkMeshLanguage.systemPrompt(language)] : [],
          small: true,
          tools: {},
          model: mdl,
          sessionID: input.session.id,
          retries: 2,
          messages: [
            {
              role: "user",
              content:
                locale === "zh-CN"
                  ? "为此会话生成一个简洁的简体中文标题：\n"
                  : "Generate a title for this conversation:\n",
            },
            ...msgs,
          ],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.orDie,
        )
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (!cleaned) return
      const t = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      yield* sessions
        .setTitle({ sessionID: input.session.id, title: t })
        .pipe(Effect.catchCause((cause) => Effect.logError("failed to generate title", { error: Cause.squash(cause) })))
    })

    const handleSubtask = Effect.fn("SessionPrompt.handleSubtask")(function* (input: {
      task: SessionV1.SubtaskPart
      model: Provider.Model
      lastUser: SessionV1.User
      sessionID: SessionID
      session: Session.Info
      msgs: SessionV1.WithParts[]
    }) {
      const { task, model, lastUser, sessionID, session, msgs } = input
      const ctx = yield* InstanceState.context
      const promptOps = yield* ops()
      const { task: taskTool } = yield* registry.named()
      const taskModel = task.model ? yield* getModel(task.model.providerID, task.model.modelID, sessionID) : model
      const assistantMessage: SessionV1.Assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: lastUser.id,
        sessionID,
        mode: task.agent,
        agent: task.agent,
        variant: lastUser.model.variant,
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: taskModel.id,
        providerID: taskModel.providerID,
        time: { created: Date.now() },
      })
      let part: SessionV1.ToolPart = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantMessage.id,
        sessionID: assistantMessage.sessionID,
        type: "tool",
        callID: ulid(),
        tool: TaskTool.id,
        state: {
          status: "running",
          input: {
            prompt: task.prompt,
            description: task.description,
            subagent_type: task.agent,
            command: task.command,
          },
          time: { start: Date.now() },
        },
      })
      const taskArgs = {
        prompt: task.prompt,
        description: task.description,
        subagent_type: task.agent,
        command: task.command,
      }
      yield* plugin.trigger(
        "tool.execute.before",
        { tool: TaskTool.id, sessionID, callID: part.id },
        { args: taskArgs },
      )

      const taskAgent = yield* agents.get(task.agent)
      if (!taskAgent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${task.agent}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
        throw error
      }

      let error: Error | undefined
      const taskAbort = new AbortController()
      const result = yield* taskTool
        .execute(taskArgs, {
          agent: task.agent,
          messageID: assistantMessage.id,
          sessionID,
          abort: taskAbort.signal,
          callID: part.callID,
          extra: { bypassAgentCheck: true, promptOps },
          messages: msgs,
          metadata: (val: { title?: string; metadata?: Record<string, any> }) =>
            Effect.gen(function* () {
              part = yield* sessions.updatePart({
                ...part,
                type: "tool",
                state: { ...part.state, ...val },
              } satisfies SessionV1.ToolPart)
            }),
          ask: (req: any) =>
            permission
              .ask({
                ...req,
                sessionID,
                ruleset: Permission.merge(taskAgent.permission, session.permission ?? []),
              })
              .pipe(Effect.orDie),
        })
        .pipe(
          Effect.catchCause((cause) => {
            const defect = Cause.squash(cause)
            error = defect instanceof Error ? defect : new Error(String(defect))
            return Effect.logError("subtask execution failed", {
              error,
              agent: task.agent,
              description: task.description,
            })
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              taskAbort.abort()
              assistantMessage.finish = "tool-calls"
              assistantMessage.time.completed = Date.now()
              yield* sessions.updateMessage(assistantMessage)
              if (part.state.status === "running") {
                yield* sessions.updatePart({
                  ...part,
                  state: {
                    status: "error",
                    error: "Cancelled",
                    time: { start: part.state.time.start, end: Date.now() },
                    metadata: part.state.metadata,
                    input: part.state.input,
                  },
                } satisfies SessionV1.ToolPart)
              }
            }),
          ),
        )

      const attachments = result?.attachments?.map((attachment) => ({
        ...attachment,
        id: PartID.ascending(),
        sessionID,
        messageID: assistantMessage.id,
      }))

      yield* plugin.trigger(
        "tool.execute.after",
        { tool: TaskTool.id, sessionID, callID: part.id, args: taskArgs },
        result,
      )

      assistantMessage.finish = "tool-calls"
      assistantMessage.time.completed = Date.now()
      yield* sessions.updateMessage(assistantMessage)

      if (result && part.state.status === "running") {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "completed",
            input: part.state.input,
            title: result.title,
            metadata: result.metadata,
            output: result.output,
            attachments,
            time: { ...part.state.time, end: Date.now() },
          },
        } satisfies SessionV1.ToolPart)
      }

      if (!result) {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "error",
            error: error ? `Tool execution failed: ${error.message}` : "Tool execution failed",
            time: {
              start: part.state.status === "running" ? part.state.time.start : Date.now(),
              end: Date.now(),
            },
            metadata: part.state.status === "pending" ? undefined : part.state.metadata,
            input: part.state.input,
          },
        } satisfies SessionV1.ToolPart)
      }

      if (!task.command) return

      const summaryUserMsg: SessionV1.User = {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: lastUser.agent,
        model: lastUser.model,
      }
      yield* sessions.updateMessage(summaryUserMsg)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: summaryUserMsg.id,
        sessionID,
        type: "text",
        text: "Summarize the task tool output above and continue with your task.",
        synthetic: true,
      } satisfies SessionV1.TextPart)
    })

    const shellImpl = Effect.fn("SessionPrompt.shellImpl")(function* (input: ShellInput, ready?: Latch.Latch) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const markReady = ready ? ready.open.pipe(Effect.asVoid) : Effect.void
          const { msg, part, cwd } = yield* Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
            if (session.revert) {
              yield* revert.cleanup(session)
            }
            const agent = yield* agents.get(input.agent)
            if (!agent) {
              const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
              const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
              const error = new NamedError.Unknown({ message: `Agent not found: "${input.agent}".${hint}` })
              yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
              throw error
            }
            const model = input.model ?? agent.model ?? (yield* currentModel(input.sessionID))
            const userMsg: SessionV1.User = {
              id: input.messageID ?? MessageID.ascending(),
              sessionID: input.sessionID,
              time: { created: Date.now() },
              role: "user",
              agent: input.agent,
              model: { providerID: model.providerID, modelID: model.modelID },
            }
            yield* sessions.updateMessage(userMsg)
            const userPart: SessionV1.Part = {
              type: "text",
              id: PartID.ascending(),
              messageID: userMsg.id,
              sessionID: input.sessionID,
              text: "The following tool was executed by the user",
              synthetic: true,
            }
            yield* sessions.updatePart(userPart)

            const msg: SessionV1.Assistant = {
              id: MessageID.ascending(),
              sessionID: input.sessionID,
              parentID: userMsg.id,
              mode: input.agent,
              agent: input.agent,
              cost: 0,
              path: { cwd: ctx.directory, root: ctx.worktree },
              time: { created: Date.now() },
              role: "assistant",
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: model.modelID,
              providerID: model.providerID,
            }
            yield* sessions.updateMessage(msg)
            const started = Date.now()
            const part: SessionV1.ToolPart = {
              type: "tool",
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: input.sessionID,
              tool: ShellID.ToolID,
              callID: ulid(),
              state: {
                status: "running",
                time: { start: started },
                input: { command: input.command },
              },
            }
            yield* sessions.updatePart(part)
            return { msg, part, cwd: ctx.directory }
          }).pipe(Effect.ensuring(markReady))

          const cfg = yield* config.get()
          const sh = Shell.preferred(cfg.shell)
          const args = Shell.args(sh, input.command, cwd)
          let output = ""
          let aborted = false

          const finish = Effect.uninterruptible(
            Effect.gen(function* () {
              if (aborted) {
                output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
              }
              const completed = Date.now()
              if (!msg.time.completed) {
                msg.time.completed = completed
                yield* sessions.updateMessage(msg)
              }
              if (part.state.status === "running") {
                part.state = {
                  status: "completed",
                  time: { ...part.state.time, end: completed },
                  input: part.state.input,
                  title: "",
                  metadata: { output },
                  output,
                }
                yield* sessions.updatePart(part)
              }
            }),
          )

          const exit = yield* restore(
            Effect.gen(function* () {
              const shellEnv = yield* plugin.trigger(
                "shell.env",
                { cwd, sessionID: input.sessionID, callID: part.callID },
                { env: {} },
              )
              const cmd = ChildProcess.make(sh, args, {
                cwd,
                extendEnv: true,
                env: { ...shellEnv.env, TERM: "dumb" },
                stdin: "ignore",
                forceKillAfter: "3 seconds",
              })
              const handle = yield* spawner.spawn(cmd)
              yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
                Effect.gen(function* () {
                  output += chunk
                  if (part.state.status === "running") {
                    part.state.metadata = { output }
                    yield* sessions.updatePart(part)
                  }
                }),
              )
              yield* handle.exitCode
            }).pipe(Effect.scoped, Effect.orDie),
          ).pipe(Effect.exit)

          if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause)) {
            aborted = true
          }
          yield* finish

          if (Exit.isFailure(exit) && !aborted && !Cause.hasInterruptsOnly(exit.cause)) {
            return yield* Effect.failCause(exit.cause)
          }

          return { info: msg, parts: [part] }
        }),
      )
    })

    const getModel = Effect.fn("SessionPrompt.getModel")(function* (
      providerID: ProviderV2.ID,
      modelID: ModelV2.ID,
      sessionID: SessionID,
    ) {
      const exit = yield* provider.getModel(providerID, modelID).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) return exit.value
      const err = Cause.squash(exit.cause)
      if (Provider.ModelNotFoundError.isInstance(err)) {
        const hint = err.suggestions?.length ? ` Did you mean: ${err.suggestions.join(", ")}?` : ""
        yield* events.publish(Session.Event.Error, {
          sessionID,
          error: new NamedError.Unknown({
            message: `Model not found: ${err.providerID}/${err.modelID}.${hint}`,
          }).toObject(),
        })
      }
      return yield* Effect.die(err)
    })

    const currentModel = Effect.fnUntraced(function* (sessionID: SessionID) {
      const current = yield* db
        .select({ model: SessionTable.model })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (current?.model) {
        return {
          providerID: ProviderV2.ID.make(current.model.providerID),
          modelID: ModelV2.ID.make(current.model.id),
          ...(current.model.variant && current.model.variant !== "default" ? { variant: current.model.variant } : {}),
        }
      }
      const match = yield* sessions
        .findMessage(sessionID, (m) => m.info.role === "user" && !!m.info.model)
        .pipe(Effect.orDie)
      if (Option.isSome(match) && match.value.info.role === "user") return match.value.info.model
      return yield* provider.defaultModel().pipe(Effect.orDie)
    })

    const composeAsync = <A>(operation: () => Promise<A>) =>
      Effect.tryPromise({
        try: operation,
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(Effect.orDie)

    const composeRuntime = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      return yield* composeAsync(() => createComposeService({ directory: ctx.project.worktree }))
    })

    const publishCompose = (run: Compose.Info) => events.publish(ComposeEvent.Updated, { run })

    const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (input: PromptInput) {
      const agentName = input.agent
      const ag = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!ag) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      if (ComposePermission.isInternal(ag.name) && !(yield* ComposeInternal)) {
        const language = WorkMeshCommandLocale.resolve(yield* workmeshLanguage.get())
        const error = new NamedError.Unknown({
          message:
            language === "zh-CN"
              ? `Agent ${ag.name} 仅供 Compose 运行时内部调用。`
              : `Agent ${ag.name} is reserved for internal Compose runtime calls.`,
        })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const locksSessionMode =
        !input.noReply &&
        input.parts.some((part) => part.type !== "text" || !("synthetic" in part) || part.synthetic !== true)
      if (WorkMeshProduct.enabled && locksSessionMode) {
        const history = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
        const firstUser = history.find(
          (message) =>
            message.info.role === "user" &&
            message.parts.some(
              (part) => part.type !== "compaction" && (!("synthetic" in part) || part.synthetic !== true),
            ),
        )
        if (firstUser?.info.role === "user") {
          const composeLocked = COMPOSE_AGENTS.has(firstUser.info.agent)
          const enteringCompose = COMPOSE_AGENTS.has(ag.name)
          if (composeLocked !== enteringCompose) {
            const language = WorkMeshCommandLocale.resolve(yield* workmeshLanguage.get())
            const message =
              language === "zh-CN"
                ? composeLocked
                  ? "此会话已锁定为 Compose 模式，后续消息必须继续使用 Compose。"
                  : "此会话已经以 Build/Plan 模式开始，不能中途切换为 Compose；请新建会话。"
                : composeLocked
                  ? "This session is locked to Compose mode; subsequent messages must continue in Compose."
                  : "This session started in Build/Plan mode and cannot switch to Compose; start a new session."
            const error = new NamedError.Unknown({ message })
            yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
            throw error
          }
        }
      }

      const model = input.model ?? ag.model ?? (yield* currentModel(input.sessionID))
      const same = ag.model && model.providerID === ag.model.providerID && model.modelID === ag.model.modelID
      const full =
        !input.variant && ag.variant && same
          ? yield* provider
              .getModel(model.providerID, model.modelID)
              .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
          : undefined
      const variant = input.variant ?? (ag.variant && full?.variants?.[ag.variant] ? ag.variant : undefined)

      const info: SessionV1.User = {
        id: input.messageID ?? MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        tools: input.tools,
        agent: ag.name,
        model: {
          providerID: model.providerID,
          modelID: model.modelID,
          variant,
        },
        system: input.system,
        format: input.format,
      }

      const current = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      // 用户命令采用显式收件箱，不启动后台轮询，避免消息在对方执行任务时打断会话。
      if (
        current.agent !== info.agent ||
        current.model?.providerID !== info.model.providerID ||
        current.model?.id !== info.model.modelID ||
        (current.model?.variant === "default" ? undefined : current.model?.variant) !== info.model.variant
      ) {
        yield* sessions.setAgentModel({
          sessionID: input.sessionID,
          agent: info.agent,
          model: {
            id: info.model.modelID,
            providerID: info.model.providerID,
            variant: info.model.variant ?? "default",
          },
          time: info.time.created,
        })
      }

      yield* Effect.addFinalizer(() => instruction.clear(info.id))

      type Draft<T> = T extends SessionV1.Part ? Omit<T, "id"> & { id?: string } : never
      const assign = (part: Draft<SessionV1.Part>): SessionV1.Part => ({
        ...part,
        id: part.id ? PartID.make(part.id) : PartID.ascending(),
      })

      const resolvePart: (part: PromptInput["parts"][number]) => Effect.Effect<Draft<SessionV1.Part>[]> = Effect.fn(
        "SessionPrompt.resolveUserPart",
      )(function* (part) {
        if (part.type === "file") {
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            yield* Effect.logInfo("mcp resource", { clientName, uri, mime: part.mime })
            const pieces: Draft<SessionV1.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]
            const exit = yield* mcp.readResource(clientName, uri).pipe(Effect.exit)
            if (Exit.isSuccess(exit)) {
              const content = exit.value
              if (!content) throw new Error(`Resource not found: ${clientName}/${uri}`)
              const items = Array.isArray(content.contents) ? content.contents : [content.contents]
              for (const c of items) {
                if (!c || typeof c !== "object") continue
                if ("text" in c && typeof c.text === "string" && c.text) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: c.text,
                  })
                } else if ("blob" in c && typeof c.blob === "string" && c.blob) {
                  const mime = "mimeType" in c && typeof c.mimeType === "string" ? c.mimeType : part.mime
                  const filename = "uri" in c && typeof c.uri === "string" ? c.uri : part.filename
                  const size = mcpResourceBase64Size(c.blob)
                  if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Binary MCP resource omitted: ${filename ?? uri} (${mime}, ${formatMcpResourceBytes(size)}) is not a supported attachment type]`,
                    })
                    continue
                  }
                  if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Binary MCP resource omitted: ${filename ?? uri} (${mime}, ${formatMcpResourceBytes(size)}) exceeds ${formatMcpResourceBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
                    })
                    continue
                  }
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary MCP resource attached: ${filename ?? uri} (${mime})]`,
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "file",
                    mime,
                    filename,
                    url: `data:${mime};base64,${c.blob}`,
                  })
                }
              }
            } else {
              const error = Cause.squash(exit.cause)
              yield* Effect.logError("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }
            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: decodeDataUrl(part.url),
                  },
                  { ...part, messageID: info.id, sessionID: input.sessionID },
                ]
              }
              break
            case "file:": {
              yield* Effect.logInfo("file", { mime: part.mime })
              const filepath = fileURLToPath(part.url)
              const mime = (yield* fsys.isDir(filepath)) ? "application/x-directory" : part.mime

              const { read } = yield* registry.named()
              const execRead = (args: Parameters<typeof read.execute>[0], extra?: Tool.Context["extra"]) => {
                const controller = new AbortController()
                return read
                  .execute(args, {
                    sessionID: input.sessionID,
                    abort: controller.signal,
                    agent: input.agent!,
                    messageID: info.id,
                    extra: { bypassCwdCheck: true, ...extra },
                    messages: [],
                    metadata: () => Effect.void,
                    ask: () => Effect.void,
                  })
                  .pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
              }

              if (mime === "text/plain") {
                let offset: number | undefined
                let limit: number | undefined
                const range = { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  if (start === end) {
                    const symbols = yield* lsp.documentSymbol(filePathURI).pipe(Effect.catch(() => Effect.succeed([])))
                    for (const symbol of symbols) {
                      let r: LSP.Range | undefined
                      if ("range" in symbol) r = symbol.range
                      else if ("location" in symbol) r = symbol.location.range
                      if (r?.start?.line && r?.start?.line === start) {
                        start = r.start.line
                        end = r?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start, 1)
                  if (end) limit = end - (offset - 1)
                }
                const args = { filePath: filepath, offset, limit }
                const pieces: Draft<SessionV1.Part>[] = [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]
                const exit = yield* provider.getModel(info.model.providerID, info.model.modelID).pipe(
                  Effect.flatMap((mdl) => execRead(args, { model: mdl })),
                  Effect.exit,
                )
                if (Exit.isSuccess(exit)) {
                  const result = exit.value
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  })
                  if (result.attachments?.length) {
                    pieces.push(
                      ...result.attachments.map((a) => ({
                        ...a,
                        synthetic: true,
                        filename: a.filename ?? part.filename,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })),
                    )
                  } else {
                    pieces.push({ ...part, mime, messageID: info.id, sessionID: input.sessionID })
                  }
                } else {
                  const error = Cause.squash(exit.cause)
                  yield* Effect.logError("failed to read file", { error, filepath })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* events.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                  })
                }
                return pieces
              }

              if (mime === "application/x-directory") {
                const args = { filePath: filepath }
                const exit = yield* execRead(args).pipe(Effect.exit)
                if (Exit.isFailure(exit)) {
                  const error = Cause.squash(exit.cause)
                  yield* Effect.logError("failed to read directory", { error, filepath })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* events.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  return [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    },
                  ]
                }
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: exit.value.output,
                  },
                  { ...part, mime, messageID: info.id, sessionID: input.sessionID },
                ]
              }

              return [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                },
                {
                  id: part.id,
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url:
                    `data:${mime};base64,` +
                    Buffer.from(yield* fsys.readFile(filepath).pipe(Effect.catch(Effect.die))).toString("base64"),
                  mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
            }
          }
        }

        if (part.type === "agent") {
          const perm = Permission.evaluate("task", part.name, ag.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            { ...part, messageID: info.id, sessionID: input.sessionID },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [{ ...part, messageID: info.id, sessionID: input.sessionID }]
      })

      const resolvedParts = yield* Effect.forEach(input.parts, resolvePart, { concurrency: "unbounded" }).pipe(
        Effect.map((x) => x.flat().map(assign)),
      )

      yield* plugin.trigger(
        "chat.message",
        {
          sessionID: input.sessionID,
          agent: input.agent,
          model: input.model,
          messageID: input.messageID,
          variant: input.variant,
        },
        { message: info, parts: resolvedParts },
      )

      const parts = yield* Effect.forEach(resolvedParts, (part) =>
        part.type === "file" && part.mime.startsWith("image/")
          ? image.normalize(part).pipe(
              Effect.catchIf(
                (error) => error instanceof Image.ResizerUnavailableError,
                () => Effect.succeed(part),
              ),
            )
          : Effect.succeed(part),
      )

      const parsed = decodeMessageInfo(info, { errors: "all", propertyOrder: "original" })
      if (Exit.isFailure(parsed)) {
        yield* Effect.logError("invalid user message before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          agent: info.agent,
          model: info.model,
          cause: Cause.pretty(parsed.cause),
        })
      }
      for (const [index, part] of parts.entries()) {
        const p = decodeMessagePart(part, { errors: "all", propertyOrder: "original" })
        if (Exit.isSuccess(p)) continue
        yield* Effect.logError("invalid user part before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          partID: part.id,
          partType: part.type,
          index,
          cause: Cause.pretty(p.cause),
          part,
        })
      }

      yield* sessions.updateMessage(info)
      for (const part of parts) yield* sessions.updatePart(part)

      return { info, parts }
    }, Effect.scoped)

    const prompt: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error> = Effect.fn(
      "SessionPrompt.prompt",
    )(function* (input: PromptInput) {
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      yield* revert.cleanup(session)
      const message = yield* createUserMessage(input)
      yield* sessions.touch(input.sessionID)

      const permissions: PermissionV1.Rule[] = []
      for (const [t, enabled] of Object.entries(input.tools ?? {})) {
        permissions.push({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" })
      }
      if (permissions.length > 0) {
        session.permission = permissions
        yield* sessions.setPermission({ sessionID: session.id, permission: permissions })
      }

      if (input.noReply === true) return message
      const result = yield* loop({ sessionID: input.sessionID })
      if (!WorkMeshProduct.enabled || input.agent !== "compose" || !composeSpecReady(result)) return result
      const service = yield* composeRuntime()
      const run = (yield* composeAsync(() => service.list())).find(
        (item) => item.sessionID === input.sessionID && item.mode === "interactive" && item.phase === "grill",
      )
      if (!run) return result
      const spec = yield* composeAsync(() => writeComposeSpecDraft(run, composeSpecText(result)))
      const persisted = yield* composeAsync(() => service.saveSpec({ id: run.id, revision: run.revision, spec }))
      yield* publishCompose(persisted)
      const specified = yield* composeAsync(() => service.transition({ id: run.id, phase: "spec" }))
      yield* publishCompose(specified)
      yield* publishCompose(yield* composeAsync(() => service.transition({ id: run.id, phase: "awaiting_approval" })))
      return result
    })

    const executeLoopJob = Effect.fn("SessionPrompt.executeLoopJob")(function* (
      job: WorkMeshLoops.LoopJob,
      messageID?: MessageID,
    ) {
      return yield* loops.withSessionLock(
        job.sessionID,
        Effect.gen(function* () {
          if (!(yield* loops.get(job.id))) return undefined
          const result = yield* prompt({
            sessionID: job.sessionID,
            messageID,
            model: job.model,
            agent: job.agent,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: [
                  "<system-reminder>",
                  `正在执行 WorkMesh 循环任务 ${job.id}。`,
                  "本次只执行一次任务内容；后续周期由调度器负责。",
                  "</system-reminder>",
                  "",
                  job.prompt,
                ].join("\n"),
              },
            ],
          }).pipe(Effect.exit)
          yield* loops.completeTick(job.id, Exit.isSuccess(result))
          return yield* result
        }),
      )
    })

    const init = Effect.fn("SessionPrompt.init")(function* () {
      if (!WorkMeshProduct.enabled) return
      const data = yield* InstanceState.get(schedulerState)
      if (data.started) return
      data.started = true
      yield* Effect.gen(function* () {
        while (true) {
          yield* loops.claimDue().pipe(
            Effect.flatMap((jobs) =>
              Effect.forEach(
                jobs,
                (job) =>
                  executeLoopJob(job).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("WorkMesh 循环任务执行失败", { jobID: job.id, cause }),
                    ),
                    Effect.forkIn(data.scope),
                  ),
                { discard: true },
              ),
            ),
            Effect.catchCause((cause) => Effect.logWarning("WorkMesh 循环调度检查失败", { cause })),
          )
          yield* Effect.sleep("1 second")
        }
      }).pipe(Effect.forkIn(data.scope, { startImmediately: true }))
    })

    const lastAssistant = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role !== "user").pipe(Effect.orDie)
      if (Option.isSome(match)) return match.value
      const msgs = yield* sessions.messages({ sessionID, limit: 1 }).pipe(Effect.orDie)
      if (msgs.length > 0) return msgs[0]
      throw new Error("Impossible")
    })

    const runLoop = Effect.fn("SessionPrompt.run")(function* (sessionID: SessionID) {
      const ctx = yield* InstanceState.context
      let structured: unknown
      let step = 0
      const session = yield* sessions.get(sessionID).pipe(Effect.orDie)

      while (true) {
        yield* status.set(sessionID, { type: "busy" })
        yield* Effect.logInfo("loop", { "session.id": sessionID, step })

        let msgs = yield* MessageV2.filterCompactedEffect(sessionID).pipe(
          Effect.provideService(Database.Service, database),
        )

        const { user: lastUser, assistant: lastAssistant, finished: lastFinished, tasks } = MessageV2.latest(msgs)

        if (!lastUser) throw new Error("No user message found in stream. This should never happen.")

        const lastAssistantMsg = msgs.findLast(
          (msg) => msg.info.role === "assistant" && msg.info.id === lastAssistant?.id,
        )
        // Some providers return "stop" even when the assistant message contains
        // tool calls. Keep the loop running so tool results can be sent back to
        // the model, but ignore cleanup-marked interrupted orphans.
        const hasToolCalls =
          lastAssistantMsg?.parts.some(
            (part) => part.type === "tool" && !part.metadata?.providerExecuted && !isOrphanedInterruptedTool(part),
          ) ?? false

        if (
          lastAssistant?.finish &&
          !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
          !hasToolCalls &&
          lastAssistant.parentID === lastUser.id
        ) {
          const orphan = lastAssistantMsg?.parts.find(
            (part): part is SessionV1.ToolPart => part.type === "tool" && isOrphanedInterruptedTool(part),
          )
          if (orphan) {
            yield* Effect.logWarning("loop exit with orphaned interrupted tool", {
              "session.id": sessionID,
              messageID: lastAssistant.id,
              tool: orphan.tool,
              callID: orphan.callID,
            })
          }
          yield* Effect.logInfo("exiting loop", { "session.id": sessionID })
          break
        }

        step++
        if (step === 1)
          yield* title({
            session,
            modelID: lastUser.model.modelID,
            providerID: lastUser.model.providerID,
            history: msgs,
          }).pipe(Effect.ignore, Effect.forkIn(scope))

        const model = yield* getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)
        const task = tasks.pop()

        if (task?.type === "subtask") {
          yield* handleSubtask({ task, model, lastUser, sessionID, session, msgs })
          continue
        }

        if (task?.type === "compaction") {
          const result = yield* compaction.process({
            messages: msgs,
            parentID: lastUser.id,
            sessionID,
            auto: task.auto,
            overflow: task.overflow,
          })
          if (result === "stop") break
          continue
        }

        if (
          lastFinished &&
          lastFinished.summary !== true &&
          (yield* compaction.isOverflow({ tokens: lastFinished.tokens, model }))
        ) {
          yield* compaction.create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
          continue
        }

        const agent = yield* agents.get(lastUser.agent)
        if (!agent) {
          const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
          const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
          const error = new NamedError.Unknown({ message: `Agent not found: "${lastUser.agent}".${hint}` })
          yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
          throw error
        }
        const maxSteps = agent.steps ?? Infinity
        const isLastStep = step >= maxSteps
        msgs = yield* SessionReminders.apply({ messages: msgs, agent, session }).pipe(
          Effect.provideService(RuntimeFlags.Service, flags),
          Effect.provideService(FSUtil.Service, fsys),
          Effect.provideService(Session.Service, sessions),
        )

        const msg: SessionV1.Assistant = {
          id: MessageID.ascending(),
          parentID: lastUser.id,
          role: "assistant",
          mode: agent.name,
          agent: agent.name,
          variant: lastUser.model.variant,
          path: { cwd: ctx.directory, root: ctx.worktree },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: model.id,
          providerID: model.providerID,
          time: { created: Date.now() },
          sessionID,
        }
        yield* sessions.updateMessage(msg)

        const finalizeInterruptedAssistant = Effect.gen(function* () {
          if (msg.time.completed) return
          msg.error ??= MessageV2.fromError(new DOMException("Aborted", "AbortError"), {
            providerID: msg.providerID,
            aborted: true,
          })
          msg.time.completed = Date.now()
          yield* sessions.updateMessage(msg)
        })

        const handle = yield* processor
          .create({
            assistantMessage: msg,
            sessionID,
            model,
          })
          .pipe(Effect.onInterrupt(() => finalizeInterruptedAssistant))

        const outcome: "break" | "continue" = yield* Effect.gen(function* () {
          const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
          const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false
          const promptOps = yield* ops()

          const tools = yield* SessionTools.resolve({
            agent,
            session,
            model,
            processor: handle,
            bypassAgentCheck,
            messages: msgs,
            promptOps,
          }).pipe(
            Effect.provideService(Plugin.Service, plugin),
            Effect.provideService(Permission.Service, permission),
            Effect.provideService(ToolRegistry.Service, registry),
            Effect.provideService(MCP.Service, mcp),
            Effect.provideService(Truncate.Service, truncate),
            Effect.provideService(RuntimeFlags.Service, flags),
          )

          if (lastUser.format?.type === "json_schema") {
            tools["StructuredOutput"] = createStructuredOutputTool({
              schema: lastUser.format.schema,
              onSuccess(output) {
                structured = output
              },
            })
          }

          if (step === 1)
            yield* summary.summarize({ sessionID, messageID: lastUser.id }).pipe(Effect.ignore, Effect.forkIn(scope))

          yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

          const [skills, env, instructions, mcpInstructions, modelMsgs] = yield* Effect.all([
            sys.skills(agent),
            sys.environment(model),
            instruction.system().pipe(Effect.orDie),
            sys.mcp(agent, session.permission),
            MessageV2.toModelMessagesEffect(msgs, model),
          ])
          const languageInstruction = WorkMeshProduct.enabled
            ? WorkMeshLanguage.systemPrompt(yield* workmeshLanguage.get())
            : undefined
          const system = [
            ...env,
            ...instructions,
            ...(languageInstruction ? [languageInstruction] : []),
            ...(mcpInstructions ? [mcpInstructions] : []),
            ...(skills ? [skills] : []),
          ]
          const format = lastUser.format ?? { type: "text" as const }
          if (format.type === "json_schema") system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
          const result = yield* handle.process({
            user: lastUser,
            agent,
            permission: session.permission,
            sessionID,
            parentSessionID: session.parentID,
            system,
            messages: [
              ...modelMsgs,
              ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS_PROMPT }] : []),
            ],
            tools,
            model,
            toolChoice: format.type === "json_schema" ? "required" : undefined,
          })

          if (structured !== undefined) {
            handle.message.structured = structured
            handle.message.finish = handle.message.finish ?? "stop"
            yield* sessions.updateMessage(handle.message)
            return "break" as const
          }

          const finished = handle.message.finish && !["tool-calls", "unknown"].includes(handle.message.finish)
          if (finished && !handle.message.error) {
            // Surface any content-filter finish (e.g. Anthropic stop_reason:
            // refusal) as an error. These turns may have produced no visible
            // output at all — previously the session went idle silently — or
            // partial text that was cut off by the provider's filter.
            if (handle.message.finish === "content-filter") {
              handle.message.error = new SessionV1.ContentFilterError({
                message: "The response was blocked by the provider's content filter",
              }).toObject()
              yield* sessions.updateMessage(handle.message)
              yield* events.publish(Session.Event.Error, { sessionID, error: handle.message.error })
              return "break" as const
            }
            if (format.type === "json_schema") {
              handle.message.error = new SessionV1.StructuredOutputError({
                message: "Model did not produce structured output",
                retries: 0,
              }).toObject()
              yield* sessions.updateMessage(handle.message)
              return "break" as const
            }
          }

          if (WorkMeshProduct.enabled && result === "stop" && !session.parentID) {
            const activeGoal = yield* goal.get(sessionID)
            if (activeGoal) {
              const transcript = yield* MessageV2.filterCompactedEffect(sessionID).pipe(
                Effect.provideService(Database.Service, database),
              )
              const verdict = yield* goal
                .evaluate({ condition: activeGoal.condition, msgs: transcript, model: lastUser.model })
                .pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("goal judge failed; allowing session to stop", { error: String(error) }).pipe(
                      Effect.as({ ok: true, reason: "judge error" } satisfies SessionGoal.Verdict),
                    ),
                  ),
                )
              if (verdict.ok || verdict.impossible) {
                yield* goal.clear(sessionID)
              } else {
                const attempt = yield* goal.bumpReact(sessionID)
                if (attempt < MAX_GOAL_REACT) {
                  const reentry: SessionV1.User = {
                    id: MessageID.ascending(),
                    sessionID,
                    role: "user",
                    time: { created: Date.now() },
                    agent: lastUser.agent,
                    model: lastUser.model,
                  }
                  yield* sessions.updateMessage(reentry)
                  yield* sessions.updatePart({
                    id: PartID.ascending(),
                    messageID: reentry.id,
                    sessionID,
                    type: "text",
                    synthetic: true,
                    text: [
                      "<system-reminder>",
                      `停止条件仍未满足：${activeGoal.condition}`,
                      `独立检查指出：${verdict.reason}`,
                      `继续完成任务。这是最多 ${MAX_GOAL_REACT} 次中的第 ${attempt} 次续跑。`,
                      "</system-reminder>",
                    ].join("\n"),
                  } satisfies SessionV1.TextPart)
                  return "continue" as const
                }
                yield* Effect.logWarning("goal reached retry cap; allowing session to stop", {
                  sessionID,
                  condition: activeGoal.condition,
                  attempts: attempt,
                })
                yield* goal.clear(sessionID)
              }
            }
          }

          if (result === "stop") return "break" as const
          if (result === "compact") {
            yield* compaction.create({
              sessionID,
              agent: lastUser.agent,
              model: lastUser.model,
              auto: true,
              overflow: !handle.message.finish,
            })
          }
          return "continue" as const
        }).pipe(
          Effect.ensuring(instruction.clear(handle.message.id)),
          Effect.onInterrupt(() => finalizeInterruptedAssistant),
        )
        if (outcome === "break") break
        continue
      }

      yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
      return yield* lastAssistant(sessionID)
    })

    const loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts> = Effect.fn("SessionPrompt.loop")(function* (
      input: LoopInput,
    ) {
      return yield* state.ensureRunning(
        input.sessionID,
        lastAssistant(input.sessionID),
        runLoop(input.sessionID).pipe(Effect.provideService(SessionGoal.Service, goal)),
      )
    })

    const shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError> = Effect.fn(
      "SessionPrompt.shell",
    )(function* (input: ShellInput) {
      const ready = yield* Latch.make()
      return yield* state.startShell(input.sessionID, lastAssistant(input.sessionID), shellImpl(input, ready), ready)
    })

    const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {
      yield* Effect.logInfo("command", {
        "session.id": input.sessionID,
        command: input.command,
        agent: input.agent,
      })
      const cmd = yield* commands.get(input.command)
      if (!cmd) {
        const available = (yield* commands.list()).map((c) => c.name)
        const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Command not found: "${input.command}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const agentName = cmd.agent ?? input.agent

      if (
        WorkMeshProduct.enabled &&
        (input.command === Command.Default.TERMINALS ||
          input.command === Command.Default.MESSAGE ||
          input.command === Command.Default.MESSAGES)
      ) {
        const instance = yield* InstanceState.context
        const coordinator = yield* Effect.promise(() =>
          createWorkMeshCoordinator(instance.worktree === "/" ? instance.directory : instance.worktree, db),
        )
        const terminalId = `session:${input.sessionID}`
        const locale = WorkMeshCommandLocale.resolve(yield* workmeshLanguage.get())
        const text = (chinese: string, english: string) => (locale === "zh-CN" ? chinese : english)
        yield* Effect.promise(() =>
          coordinator.register({
            terminalId,
            sessionId: input.sessionID,
            displayName: `WorkMesh ${String(input.sessionID).slice(-8)}`,
            role: agentName,
            capabilities: ["message", "task"],
            status: "online",
            workspaceMode: "shared",
          }),
        )

        const respond = (content: string) =>
          prompt({
            sessionID: input.sessionID,
            messageID: input.messageID,
            agent: agentName,
            parts: [{ type: "text" as const, text: content, synthetic: true }],
            noReply: true,
          })

        if (input.command === Command.Default.TERMINALS) {
          const agents = (yield* Effect.promise(() => coordinator.listAgents())).filter(
            (agent) => agent.terminalId !== terminalId && agent.status !== "released",
          )
          const content = agents.length
            ? [
                text(`当前终端：${terminalId}\n可发送消息的终端：`, `Current terminal: ${terminalId}\nAvailable terminals:`),
                ...agents.map(
                  (agent) =>
                    `- ${agent.displayName} | ${agent.terminalId} | ${agent.status} | ${agent.workspaceMode}`,
                ),
                text(
                  `发送方式：/message <终端ID> <消息>`,
                  `Usage: /message <terminal-id> <message>`,
                ),
              ].join("\n")
            : text(
                `当前终端：${terminalId}\n当前项目没有其他已注册终端。`,
                `Current terminal: ${terminalId}\nNo other terminal is registered.`,
              )
          return yield* respond(content)
        }

        if (input.command === Command.Default.MESSAGE) {
          const match = input.arguments.trim().match(/^(\S+)\s+([\s\S]+)$/)
          if (!match) {
            return yield* respond(
              text(
                "请在 TUI 中直接输入 /message，通过弹窗选择终端并填写消息。\n脚本用法：/message <终端ID> <消息>",
                "Enter /message in the TUI to select a terminal and compose the message.\nScript usage: /message <terminal-id> <message>",
              ),
            )
          }
          const sent = yield* Effect.promise(() =>
            coordinator.sendMessage({
              senderTerminalId: terminalId,
              recipientTerminalId: match[1],
              message: match[2],
              idempotencyKey: input.messageID ? `command:${input.messageID}` : undefined,
            }),
          )
          return yield* respond(
            text(
              `消息已发送到 ${sent.recipientTerminalId}，消息 ID：${sent.id}。`,
              `Message sent to ${sent.recipientTerminalId}. Message ID: ${sent.id}.`,
            ),
          )
        }

        const messages = yield* Effect.promise(() => coordinator.listMessages(terminalId, { unreadOnly: true }))
        if (messages.length === 0) {
          return yield* respond(text("当前没有未读消息。", "There are no unread messages."))
        }
        yield* Effect.forEach(
          messages,
          (message) => Effect.promise(() => coordinator.acknowledgeMessage(terminalId, message.id)),
          { concurrency: 1 },
        )
        return yield* respond(
          [
            text(`收到 ${messages.length} 条未读消息：`, `${messages.length} unread message(s):`),
            ...messages.map(
              (message) =>
                `- [${new Date(message.createdAt).toLocaleString(locale)}] ${message.senderTerminalId}: ${message.message}`,
            ),
          ].join("\n"),
        )
      }

      if (
        WorkMeshProduct.enabled &&
        (input.command === Command.Default.COMPOSE || input.command === Command.Default.COMPOSE_NEXT)
      ) {
        const service = yield* composeRuntime()
        const interactiveCompose = input.command === Command.Default.COMPOSE_NEXT
        const composeLanguage = yield* workmeshLanguage.get()
        const composeChinese = WorkMeshCommandLocale.resolve(composeLanguage) === "zh-CN"
        const composeText = (chinese: string, english: string) => (composeChinese ? chinese : english)
        const tokens = (input.arguments.match(argsRegex) ?? []).map((item) => item.replace(quoteTrimRegex, ""))
        const operation = tokens[0]?.toLowerCase()
        const actions = new Set([
          "status",
          "approve",
          "approve_head",
          "approve_working",
          "revise",
          "resume",
          "cancel",
          "merge",
          "pr",
          "push",
          "keep",
          "discard",
        ])
        const notice = (text: string) =>
          prompt({
            sessionID: input.sessionID,
            messageID: input.messageID,
            agent: "compose",
            parts: [{ type: "text", text, synthetic: true }],
            noReply: true,
          })
        const resolveRun = Effect.fnUntraced(function* (id?: string) {
          const run = id
            ? yield* composeAsync(() => service.get(Schema.decodeUnknownSync(Compose.ID)(id)))
            : (yield* composeAsync(() => service.list())).find((item) => item.sessionID === input.sessionID)
          if (!run)
            throw new Error(composeText("当前会话没有可用的 Compose 运行", "This session has no available Compose run"))
          if (run.sessionID && run.sessionID !== input.sessionID)
            throw new Error(
              composeText("Compose 运行不属于当前会话", "The Compose run does not belong to this session"),
            )
          return run
        })
        const update = Effect.fnUntraced(function* (runPromise: Promise<Compose.Info>) {
          const run = yield* composeAsync(() => runPromise)
          yield* publishCompose(run)
          return run
        })
        const saveSpec = Effect.fnUntraced(function* (run: Compose.Info, result: SessionV1.WithParts) {
          const spec = yield* composeAsync(() => writeComposeSpecDraft(run, composeSpecText(result)))
          return yield* update(
            service.saveSpec({
              id: run.id,
              revision: run.revision,
              spec: { ...spec, approvedPath: undefined, approvedSha256: undefined },
            }),
          )
        })
        const markFailed = (id: Compose.ID, cause: Cause.Cause<unknown>, lease?: ExecutionLease) =>
          update(service.fail(id, errorMessage(Cause.squash(cause)) || "Compose 执行失败", lease)).pipe(Effect.ignore)
        const continueToFinish = (run: Compose.Info, instruction: string, lease: ExecutionLease) =>
          Effect.gen(function* () {
            yield* composeAsync(() => service.assertExecutionLease(run.id, lease))
            const worktree = run.git.worktree
            if (!worktree)
              throw new Error(
                composeText("Compose 运行缺少实施 Worktree", "The Compose run has no implementation worktree"),
              )
            const parent = yield* InstanceState.context
            const isolated = { ...parent, directory: worktree, worktree }
            const approvedSpecPath = yield* composeAsync(() => verifyApprovedComposeSpec(run, worktree))
            yield* composeAsync(() => service.assertExecutionLease(run.id, lease))
            const runPrompt = Effect.fnUntraced(function* (
              agent: "compose-execute" | "compose-review",
              text: string,
              format?: PromptInput["format"],
            ) {
              yield* composeAsync(() => service.assertExecutionLease(run.id, lease))
              const sessionID =
                agent === "compose-review"
                  ? (yield* sessions
                      .create({ parentID: input.sessionID, title: `Compose Review ${run.id}`, agent })
                      .pipe(Effect.provideService(InstanceRef, isolated))).id
                  : input.sessionID
              const result = yield* prompt({
                sessionID,
                model: input.model ? Provider.parseModel(input.model) : undefined,
                agent,
                variant: input.variant,
                format,
                parts: [{ type: "text", text, synthetic: true }],
              }).pipe(Effect.provideService(InstanceRef, isolated), Effect.provideService(ComposeInternal, true))
              yield* composeAsync(() => service.assertExecutionLease(run.id, lease))
              return result
            })
            const reviewEvidence = Effect.fnUntraced(function* (current: Compose.Info, reviewedTreeHash: string) {
              yield* composeAsync(() => service.assertExecutionLease(current.id, lease))
              const base = current.git.baseSha ?? "HEAD"
              const head = yield* composeAsync(() => Process.text(["git", "rev-parse", "HEAD"], { cwd: worktree }))
              const status = yield* composeAsync(() =>
                Process.text(["git", "diff", "--name-status", base, reviewedTreeHash, "--"], { cwd: worktree }),
              )
              const diff = yield* composeAsync(() =>
                Process.text(["git", "diff", "--no-ext-diff", "--binary", base, reviewedTreeHash, "--"], {
                  cwd: worktree,
                }),
              )
              const file = path.join(worktree, ".workmesh", "review", current.id, "evidence.md")
              const persisted = path.join(
                current.projectRoot,
                ".workmesh",
                "state",
                "compose",
                current.id,
                "review-evidence.md",
              )
              const content = [
                `# Compose Review Evidence ${current.id}`,
                `Spec: ${approvedSpecPath ?? "missing"}`,
                `Spec SHA-256: ${current.spec?.approvedSha256 ?? current.spec?.sha256 ?? "missing"}`,
                `Base SHA: ${base}`,
                `Current SHA: ${head.text.trim()}`,
                `Reviewed tree: ${reviewedTreeHash}`,
                `Verification: ${current.verificationSummary ?? "missing"}`,
                "",
                `Command: git diff --no-ext-diff --binary ${base} ${reviewedTreeHash} --`,
                "",
                "## Status",
                status.text
                  .split(/\r?\n/)
                  .filter((line) => line && !line.slice(3).replaceAll("\\", "/").startsWith(".workmesh/"))
                  .join("\n") || "(clean)",
                "",
                "## Tracked Diff",
                diff.text || "(no tracked diff)",
              ].join("\n")
              yield* composeAsync(() =>
                Promise.all([
                  mkdir(path.dirname(file), { recursive: true }).then(() => Bun.write(file, content)),
                  mkdir(path.dirname(persisted), { recursive: true }).then(() => Bun.write(persisted, content)),
                ]),
              )
              yield* composeAsync(() => service.assertExecutionLease(current.id, lease))
              return file
            })
            const taskPlanFormat = {
              type: "json_schema" as const,
              schema: {
                type: "object",
                properties: {
                  tasks: {
                    type: "array",
                    minItems: 1,
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        description: { type: "string" },
                        acceptance: { type: "array", items: { type: "string" }, minItems: 1 },
                        dependsOn: { type: "array", items: { type: "string" } },
                        covers: { type: "array", items: { type: "string" }, minItems: 1 },
                        files: { type: "array", items: { type: "string" }, minItems: 1 },
                      },
                      required: ["id", "description", "acceptance", "dependsOn", "covers", "files"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["tasks"],
                additionalProperties: false,
              },
              retryCount: 1,
            }
            const reviewFormat = {
              type: "json_schema" as const,
              schema: {
                type: "object",
                properties: {
                  ready: { type: "boolean" },
                  summary: { type: "string" },
                  critical: { type: "array", items: { type: "string" } },
                  important: { type: "array", items: { type: "string" } },
                  minor: { type: "array", items: { type: "string" } },
                },
                required: ["ready", "summary", "critical", "important", "minor"],
                additionalProperties: false,
              },
              retryCount: 1,
            }
            const structured = (result: SessionV1.WithParts) =>
              result.info.role === "assistant" && result.info.structured && typeof result.info.structured === "object"
                ? (result.info.structured as Record<string, unknown>)
                : {}
            const issueList = (value: unknown) =>
              Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
            const taskPlan = (value: unknown): Compose.Task[] => {
              if (!Array.isArray(value)) return []
              return value.flatMap((item) => {
                if (!item || typeof item !== "object" || Array.isArray(item)) return []
                const task = item as Record<string, unknown>
                if (typeof task.id !== "string" || typeof task.description !== "string") return []
                const acceptance = issueList(task.acceptance)
                if (!acceptance.length) return []
                return [
                  {
                    id: task.id.trim(),
                    description: task.description.trim(),
                    acceptance,
                    dependsOn: issueList(task.dependsOn),
                    covers: issueList(task.covers),
                    files: issueList(task.files),
                    status: "pending" as const,
                    attempt: 0,
                  },
                ]
              })
            }
            let current = run
            const reportPrompt = Effect.fnUntraced(function* () {
              const result = yield* runPrompt(
                "compose-review",
                composeText(
                  `生成最终交付报告：列出实际改动、任务结果、验证结果、Review 结论、剩余风险和最多五条 Journey Log。已批准规格：${approvedSpecPath}\n验证摘要：${current.verificationSummary}\nReview 摘要：${current.reviewSummary}\n不得执行任何 Git 收尾操作。`,
                  `Produce the final delivery report with actual changes, task results, verification results, the review conclusion, residual risk, and at most five Journey Log entries. Approved specification: ${approvedSpecPath}\nVerification summary: ${current.verificationSummary}\nReview summary: ${current.reviewSummary}\nDo not perform any Git finish action.`,
                ),
              )
              const reportPath = path.join(
                current.projectRoot,
                ".workmesh",
                "state",
                "compose",
                current.id,
                "final-report.md",
              )
              yield* composeAsync(() => Bun.write(reportPath, composeSpecText(result) + "\n"))
              yield* composeAsync(() => service.assertExecutionLease(current.id, lease))
              current = yield* update(
                service.update(current.id, "final-report-written", (run) => ({ ...run, reportPath }), lease),
              )
              return result
            })
            const awaitFinish = Effect.fnUntraced(function* () {
              yield* composeAsync(() => service.assertExecutionLease(current.id, lease))
              const digest = yield* composeAsync(() => composeWorktreeDigest(worktree))
              if (!current.git.reviewedTreeHash || digest !== current.git.reviewedTreeHash) {
                throw new Error(
                  composeText(
                    "Compose 工作树在 Review 通过后发生变化，必须重新验证和 Review。",
                    "The Compose worktree changed after review and must be verified and reviewed again.",
                  ),
                )
              }
              const head = yield* composeAsync(() => Process.text(["git", "rev-parse", "HEAD"], { cwd: worktree }))
              yield* composeAsync(() => service.assertExecutionLease(current.id, lease))
              current = yield* update(
                service.update(current.id, "finish-metadata-recorded", (run) => ({
                  ...run,
                  git: { ...run.git, headSha: head.text.trim() },
                }), lease),
              )
              return yield* update(service.awaitFinish(current.id, lease))
            })
            const applyPendingFix = Effect.fnUntraced(function* () {
              const fixes = current.pendingFixes ?? []
              const kind = current.pendingFixKind
              if (current.phase !== "implement" || !kind || !fixes.length) return
              yield* runPrompt(
                "compose-execute",
                kind === "review"
                  ? composeText(
                      `修复独立 Review 发现的 Critical 问题，不得扩大范围：\n${fixes.join("\n")}`,
                      `Fix these Critical findings from the independent review without expanding scope:\n${fixes.join("\n")}`,
                    )
                  : composeText(
                      `修复验证发现的问题，然后等待下一轮验证：\n${fixes.join("\n")}`,
                      `Fix the issues found by verification, then wait for the next verification round:\n${fixes.join("\n")}`,
                    ),
              )
              current = yield* update(
                service.update(current.id, `${kind}-fix-completed`, (run) => ({
                  ...run,
                  pendingFixKind: undefined,
                  pendingFixes: undefined,
                  reviewFixAttempts: kind === "review" ? (run.reviewFixAttempts ?? 0) + 1 : run.reviewFixAttempts,
                }), lease),
              )
              current = yield* update(service.transition({ id: current.id, phase: "verify" }, lease))
            })
            if (current.phase === "report" || current.phase === "finalize") {
              if (current.phase === "report") yield* reportPrompt()
              yield* awaitFinish()
              return yield* lastAssistant(input.sessionID)
            }
            if (current.phase === "workspace")
              current = yield* update(service.transition({ id: current.id, phase: "implement" }, lease))
            if (!current.tasks.length) {
              const planned = structured(
                yield* runPrompt(
                  "compose-review",
                  composeText(
                    `读取已批准规格 ${approvedSpecPath}，提取可执行任务 DAG。ID 必须稳定且唯一，dependsOn 只能引用本清单 ID，验收条件必须可观察，files 列出预计写入范围。不得修改文件。`,
                    `Read the approved specification at ${approvedSpecPath} and extract an executable task DAG. IDs must be stable and unique, dependsOn may reference only IDs in this list, acceptance criteria must be observable, and files must list expected write scope. Do not modify files.`,
                  ),
                  taskPlanFormat,
                ),
              )
              const tasks = taskPlan(planned.tasks)
              if (!tasks.length)
                throw new Error(
                  composeText("Compose 规格未产生可执行任务", "The Compose specification produced no executable tasks"),
                )
              current = yield* update(service.setTasks(current.id, tasks, lease))
            }
            yield* applyPendingFix()
            if (current.phase === "implement") {
              while (current.tasks.some((task) => task.status !== "completed")) {
                const ready = current.tasks.filter(
                  (item) =>
                    item.status !== "completed" &&
                    item.dependsOn.every(
                      (dependency) =>
                        current.tasks.find((candidate) => candidate.id === dependency)?.status === "completed",
                    ),
                )
                const wave = ready.reduce<Compose.Task[]>((result, task) => {
                  if (result.length >= current.config.maxConcurrent) return result
                  const conflicts = result.some(
                    (selected) =>
                      !selected.files.length ||
                      !task.files.length ||
                      selected.files.some((file) =>
                        task.files.some(
                          (candidate) =>
                            file === candidate || file.startsWith(`${candidate}/`) || candidate.startsWith(`${file}/`),
                        ),
                      ),
                  )
                  return conflicts ? result : [...result, task]
                }, [])
                if (!wave.length)
                  throw new Error(
                    composeText("Compose 任务 DAG 没有可执行节点", "The Compose task DAG has no executable node"),
                  )
                const workspaces: { task: Compose.Task; workspace: TaskWorkspace }[] = []
                for (const task of wave) {
                  yield* composeAsync(() => service.assertExecutionLease(current.id, lease))
                  const workspace = yield* composeAsync(() => createComposeTaskWorkspace(current, task))
                  yield* composeAsync(() => service.assertExecutionLease(current.id, lease))
                  current = yield* update(
                    service.updateTask({
                      id: current.id,
                      taskID: task.id,
                      patch: {
                        status: "running",
                        attempt: task.status === "running" ? task.attempt : task.attempt + 1,
                        error: undefined,
                        worktree: workspace.directory,
                        branch: workspace.branch,
                      },
                    }, lease),
                  )
                  workspaces.push({ task, workspace })
                }
                yield* Effect.forEach(
                  workspaces,
                  ({ task, workspace }) => {
                    const taskInstance = { ...parent, directory: workspace.directory, worktree: workspace.directory }
                    return Effect.gen(function* () {
                      yield* composeAsync(() => service.assertExecutionLease(current.id, lease))
                      const child = yield* sessions
                        .create({
                          parentID: input.sessionID,
                          title: `Compose ${current.id}: ${task.id}`,
                          agent: "compose-execute",
                        })
                        .pipe(Effect.provideService(InstanceRef, taskInstance))
                      yield* prompt({
                        sessionID: child.id,
                        model: input.model ? Provider.parseModel(input.model) : undefined,
                        agent: "compose-execute",
                        variant: input.variant,
                        parts: [
                          {
                            type: "text",
                            text: [
                              instruction,
                              composeText(`Compose 运行：${current.id}`, `Compose run: ${current.id}`),
                              composeText(
                                `任务 Worktree：${workspace.directory}`,
                                `Task worktree: ${workspace.directory}`,
                              ),
                              composeText(
                                `当前任务：\n${JSON.stringify(task, null, 2)}`,
                                `Current task:\n${JSON.stringify(task, null, 2)}`,
                              ),
                              composeText(
                                "只允许写入任务 files 声明的范围。不得 commit、push、merge 或删除 Worktree/分支。",
                                "Write only within the task's declared files. Do not commit, push, merge, or remove worktrees/branches.",
                              ),
                            ].join("\n"),
                            synthetic: true,
                          },
                        ],
                      }).pipe(
                        Effect.provideService(InstanceRef, taskInstance),
                        Effect.provideService(ComposeInternal, true),
                      )
                      yield* composeAsync(() => service.assertExecutionLease(current.id, lease))
                    })
                  },
                  { concurrency: current.config.maxConcurrent },
                )
                yield* composeAsync(() => service.assertExecutionLease(current.id, lease))
                yield* composeAsync(() =>
                  applyComposeTaskChanges(
                    worktree,
                    workspaces.map((item) => item.workspace),
                  ),
                )
                yield* composeAsync(() => service.assertExecutionLease(current.id, lease))
                for (const task of wave) {
                  current = yield* update(
                    service.updateTask({ id: current.id, taskID: task.id, patch: { status: "completed" } }, lease),
                  )
                }
              }
              current = yield* update(service.transition({ id: current.id, phase: "verify" }, lease))
            }

            const verify = Effect.fnUntraced(function* () {
              while (true) {
                yield* composeAsync(() => verifyApprovedComposeSpec(current, worktree))
                const attempt = (current.verificationAttempts ?? 0) + 1
                if (attempt > 3)
                  throw new Error(
                    composeText(
                      "Compose 验证已达到持久化上限 3 次",
                      "Compose verification reached the persisted limit of three attempts",
                    ),
                  )
                current = yield* update(
                  service.update(current.id, "verification-attempt", (run) => ({
                    ...run,
                    verificationAttempts: (run.verificationAttempts ?? 0) + 1,
                  }), lease),
                )
                const files = [
                  ...new Set(current.tasks.flatMap((task) => task.files).map((file) => file.replaceAll("\\", "/"))),
                ].join(",")
                yield* composeAsync(() => service.assertExecutionLease(current.id, lease))
                const result = yield* composeAsync(() =>
                  Process.text(
                    [
                      "node",
                      "scripts/with-dev-env.mjs",
                      "--",
                      process.platform === "win32" ? "pnpm.cmd" : "pnpm",
                      "verify:fast",
                      "--",
                      "--files",
                      files,
                    ],
                    { cwd: worktree, nothrow: true },
                  ),
                )
                yield* composeAsync(() => service.assertExecutionLease(current.id, lease))
                const summary = (result.stderr.toString("utf8").trim() || result.text.trim() || "验证无输出").slice(
                  -4000,
                )
                if (result.code === 0) {
                  current = yield* update(
                    service.update(current.id, "verification-passed", (run) => ({
                      ...run,
                      verificationSummary: summary,
                    }), lease),
                  )
                  return
                }
                const issues = [summary]
                if (attempt >= 3)
                  throw new Error(
                    composeText(
                      `Compose 验证连续 3 次未通过：${summary}`,
                      `Compose verification failed three times: ${summary}`,
                    ),
                  )
                current = yield* update(
                  service.update(current.id, "verification-fix-pending", (run) => ({
                    ...run,
                    phase: "implement",
                    pendingFixKind: "verify",
                    pendingFixes: issues,
                  }), lease),
                )
                yield* applyPendingFix()
              }
            })

            if (current.phase === "verify") yield* verify()
            current = yield* update(service.transition({ id: current.id, phase: "review" }, lease))
            while (true) {
              yield* composeAsync(() => verifyApprovedComposeSpec(current, worktree))
              const round = current.reviewFixAttempts ?? 0
              const candidateTreeHash = yield* composeAsync(() => composeWorktreeDigest(worktree))
              const evidence = yield* reviewEvidence(current, candidateTreeHash)
              current = yield* update(
                service.update(current.id, "review-evidence-written", (run) => ({
                  ...run,
                  reviewEvidencePath: path.join(
                    run.projectRoot,
                    ".workmesh",
                    "state",
                    "compose",
                    run.id,
                    "review-evidence.md",
                  ),
                }), lease),
              )
              const result = yield* runPrompt(
                "compose-review",
                composeText(
                  `你是未参与实现的全新独立审查 Agent。读取已批准规格 ${approvedSpecPath} 和精确证据 ${evidence}，检查规格符合性、正确性和代码库一致性（Critical 修复轮次 ${round}/2）。Status 中的未跟踪文件需直接读取。只报告可验证问题并返回结构化结果。`,
                  `You are a fresh independent review agent that did not participate in implementation. Read the approved specification ${approvedSpecPath} and exact evidence ${evidence}; review specification compliance, correctness, and repository consistency (critical-fix round ${round}/2). Read untracked files listed by Status directly. Report only verifiable findings and return structured results.`,
                ),
                reviewFormat,
              )
              const data = structured(result)
              const currentTreeHash = yield* composeAsync(() => composeWorktreeDigest(worktree))
              if (currentTreeHash !== candidateTreeHash) {
                throw new Error(
                  composeText(
                    "Compose 工作树在独立 Review 期间发生变化，必须重新验证和 Review。",
                    "The Compose worktree changed during independent review and must be verified and reviewed again.",
                  ),
                )
              }
              const critical = issueList(data.critical)
              const important = issueList(data.important)
              const blocking = [...critical, ...important]
              current = yield* update(
                service.update(current.id, "review-evaluated", (run) => ({
                  ...run,
                  reviewSummary: String(data.summary ?? "Review 未提供摘要"),
                }), lease),
              )
              if (blocking.length === 0 && data.ready === true) {
                current = yield* update(
                  service.update(current.id, "review-tree-bound", (run) => ({
                    ...run,
                    git: { ...run.git, reviewedTreeHash: candidateTreeHash },
                  }), lease),
                )
                break
              }
              if (blocking.length === 0)
                throw new Error(
                  composeText(
                    `Compose 独立 Review 未确认可交付：${String(data.summary ?? "未提供原因")}`,
                    `The independent Compose review did not confirm readiness: ${String(data.summary ?? "no reason provided")}`,
                  ),
                )
              if (round >= 2)
                throw new Error(
                  composeText(
                    `阻断 Review 问题在 2 轮修复后仍存在：${blocking.join("；")}`,
                    `Blocking review findings remain after two fix rounds: ${blocking.join("; ")}`,
                  ),
                )
              current = yield* update(
                service.update(current.id, "review-fix-pending", (run) => ({
                  ...run,
                  phase: "implement",
                  pendingFixKind: "review",
                  pendingFixes: blocking,
                }), lease),
              )
              yield* applyPendingFix()
              yield* verify()
              current = yield* update(service.transition({ id: current.id, phase: "review" }, lease))
            }
            for (const task of current.tasks.filter((item) => item.status !== "completed")) {
              current = yield* update(
                service.updateTask({ id: current.id, taskID: task.id, patch: { status: "completed" } }, lease),
              )
            }
            current = yield* update(
              service.transition({ id: current.id, phase: current.config.skipReport ? "finalize" : "report" }, lease),
            )
            if (!current.config.skipReport) yield* reportPrompt()
            yield* awaitFinish()
            return yield* lastAssistant(input.sessionID)
          }).pipe(
            Effect.catchCause((cause) => markFailed(run.id, cause, lease).pipe(Effect.andThen(Effect.failCause(cause)))),
          )

        if (!operation || !actions.has(operation)) {
          const task = input.arguments.trim()
          if (!task)
            return yield* notice(
              composeText(
                "用法：/compose <任务>，或 /compose status [runID]",
                "Usage: /compose <task>, or /compose status [runID]",
              ),
            )
          const ctx = yield* InstanceState.context
          const branch = yield* composeAsync(() =>
            Process.text(["git", "branch", "--show-current"], { cwd: ctx.project.worktree }),
          )
          const baseBranch = branch.text.trim() || undefined
          const sha = yield* composeAsync(() =>
            Process.text(["git", "rev-parse", "HEAD"], { cwd: ctx.project.worktree }),
          )
          const baseSha = sha.text.trim() || undefined
          const status = yield* composeAsync(() =>
            Process.text(["git", "status", "--porcelain=v1", "--untracked-files=all"], {
              cwd: ctx.project.worktree,
            }),
          )
          const baseDirty = status.text
            .split(/\r?\n/)
            .filter(Boolean)
            .some((line) => !line.slice(3).replaceAll("\\", "/").startsWith(".workmesh/"))
          let run = yield* update(
            service.start({
              task,
              sessionID: input.sessionID,
              mode: interactiveCompose ? "interactive" : "automatic",
              language: composeLanguage === "en-US" ? "en" : composeLanguage,
              baseBranch,
              baseSha,
              baseDirty,
            }),
          )
          const result = yield* prompt({
            sessionID: input.sessionID,
            messageID: input.messageID,
            model: input.model ? Provider.parseModel(input.model) : undefined,
            agent: "compose",
            variant: input.variant,
            parts: [
              {
                type: "text",
                text: [
                  composeText(
                    interactiveCompose
                      ? "启动可持久化的交互式 Compose Next 工作流。先加载并遵循 compose-next Skill。"
                      : "启动可持久化 Compose 工作流。先加载并遵循 compose-next Skill。",
                    interactiveCompose
                      ? "Start a durable interactive Compose Next workflow. Load and follow the compose-next skill first."
                      : "Start a durable Compose workflow. Load and follow the compose-next skill first.",
                  ),
                  composeText(`运行 ID：${run.id}`, `Run ID: ${run.id}`),
                  composeText(`任务：${task}`, `Task: ${task}`),
                  composeText(
                    interactiveCompose
                      ? "当前只完成 Orient、Grill 与 Spec：检查项目上下文，逐项澄清关键决策，提出规格、验收条件、任务依赖和验证方案。"
                      : "当前只完成 Brainstorm 与 Design：检查项目上下文，澄清必要假设，提出规格、验收条件、任务依赖和验证方案。",
                    interactiveCompose
                      ? "Complete only Orient, Grill, and Spec now: inspect project context, clarify material decisions one at a time, and propose the specification, acceptance criteria, task dependencies, and verification plan."
                      : "Complete only Brainstorm and Design now: inspect project context, clarify necessary assumptions, and propose the specification, acceptance criteria, task dependencies, and verification plan.",
                  ),
                  composeText(
                    "不要修改任何产品代码，不要 commit、push、merge，不要创建或删除 Worktree/分支。请在回复末尾明确请求用户审批规格。",
                    "Do not modify product code, commit, push, merge, or create/delete worktrees or branches. Explicitly request specification approval at the end.",
                  ),
                ].join("\n"),
              },
            ],
          }).pipe(Effect.catchCause((cause) => markFailed(run.id, cause).pipe(Effect.andThen(Effect.failCause(cause)))))
          if (interactiveCompose) {
            run = yield* update(service.transition({ id: run.id, phase: "grill" }))
            if (!composeSpecReady(result)) return result
            run = yield* saveSpec(run, result)
            run = yield* update(service.transition({ id: run.id, phase: "spec" }))
          } else {
            run = yield* saveSpec(run, result)
            run = yield* update(service.transition({ id: run.id, phase: "design" }))
          }
          yield* update(service.transition({ id: run.id, phase: "awaiting_approval" }))
          return result
        }

        if (operation === "status") {
          const run = yield* resolveRun(tokens[1])
          yield* publishCompose(run)
          const completed = run.tasks.filter((task) => task.status === "completed").length
          return yield* notice(
            composeText(
              `Compose ${run.id}\n阶段：${run.phase}\n状态：${run.status}\n任务：${completed}/${run.tasks.length}`,
              `Compose ${run.id}\nPhase: ${run.phase}\nStatus: ${run.status}\nTasks: ${completed}/${run.tasks.length}`,
            ),
          )
        }

        const run = yield* resolveRun(tokens[1])
        if (operation === "cancel") {
          const cancelled = yield* update(service.cancel(run.id))
          return yield* notice(
            composeText(
              `已取消 Compose 运行 ${cancelled.id}，可使用 /compose resume ${cancelled.id} 恢复。`,
              `Cancelled Compose run ${cancelled.id}. Resume it with /compose resume ${cancelled.id}.`,
            ),
          )
        }

        if (operation === "revise") {
          const instruction = tokens.slice(2).join(" ").trim()
          const revised = yield* update(service.revise({ id: run.id, instruction }))
          const result = yield* prompt({
            sessionID: input.sessionID,
            messageID: input.messageID,
            model: input.model ? Provider.parseModel(input.model) : undefined,
            agent: "compose",
            variant: input.variant,
            parts: [
              {
                type: "text",
                text: composeText(
                  `请按以下审批意见修订 Compose 规格并重新请求审批。仍不得修改产品代码或执行 Git 写操作。\n\n${instruction}`,
                  `Revise the Compose specification using the approval feedback below, then request approval again. Do not modify product code or perform Git writes.\n\n${instruction}`,
                ),
              },
            ],
          }).pipe(
            Effect.catchCause((cause) => markFailed(revised.id, cause).pipe(Effect.andThen(Effect.failCause(cause)))),
          )
          yield* saveSpec(revised, result)
          return result
        }

        if (operation === "approve" || operation === "approve_head" || operation === "approve_working") {
          return yield* Effect.acquireUseRelease(
            composeAsync(() => service.acquireExecutionLease(run.id)),
            (lease) =>
              Effect.gen(function* () {
                const latest = yield* composeAsync(() => service.get(run.id))
                if (latest.revision !== run.revision || latest.spec?.sha256 !== run.spec?.sha256) {
                  throw new Error(
                    composeText(
                      "Compose 规格已在审批请求后发生变化，请重新审阅后再批准。",
                      "The Compose specification changed after this approval request. Review it again before approving.",
                    ),
                  )
                }
                const status = yield* composeAsync(() =>
                  Process.text(["git", "status", "--porcelain=v1", "--untracked-files=all"], {
                    cwd: latest.projectRoot,
                  }),
                )
                const baseDirty = status.text
                  .split(/\r?\n/)
                  .filter(Boolean)
                  .some((line) => !line.slice(3).replaceAll("\\", "/").startsWith(".workmesh/"))
                if (baseDirty && operation === "approve") {
                  yield* update(
                    service.update(run.id, "working-tree-status-refreshed", (current) => ({
                      ...current,
                      git: { ...current.git, baseDirty },
                    }), lease),
                  )
                  throw new Error(
                    composeText(
                      "主工作区存在未提交改动，请在审批弹窗选择“包含当前改动”或“从 HEAD 开始”。",
                      "The primary worktree has uncommitted changes. Choose Include current changes or Start from HEAD in the approval dialog.",
                    ),
                  )
                }
                const strategy: Compose.WorkspaceStrategy =
                  operation === "approve_working" ? "include_working" : "clean_head"
                const snapshot =
                  strategy === "include_working"
                    ? yield* composeAsync(() => captureComposeWorkingSnapshot(latest))
                    : undefined
                const approvedSpec = yield* composeAsync(() => approveComposeSpec(latest))
                let approved = yield* update(
                  service.approveSpec(
                    {
                      id: latest.id,
                      revision: latest.revision,
                      spec: approvedSpec,
                      strategy,
                      baseDirty,
                      workingSnapshotPath: snapshot?.path,
                      workingSnapshotSha256: snapshot?.sha256,
                    },
                    lease,
                  ),
                ).pipe(
                  Effect.tapError(() =>
                    composeAsync(() => discardTemporaryApprovedSpec(latest, approvedSpec)).pipe(Effect.ignore),
                  ),
                )
                if (!approved.git.worktree) {
                  yield* composeAsync(() => service.assertExecutionLease(approved.id, lease))
                  const info = yield* composeAsync(() => createComposeWorkspace(approved))
                  yield* composeAsync(() => service.assertExecutionLease(approved.id, lease))
                  approved = yield* update(
                    service.update(approved.id, "workspace-created", (current) => ({
                      ...current,
                      git: { ...current.git, branch: info.branch, worktree: info.directory },
                    }), lease),
                  )
                }
                return yield* continueToFinish(
                  approved,
                  composeText("用户已批准 Compose 规格。", "The user approved the Compose specification."),
                  lease,
                )
              }),
            (lease) => composeAsync(() => lease.release()).pipe(Effect.ignore),
          )
        }

        if (operation === "resume") {
          if (
            ["orient", "grill", "spec", "brainstorm", "design", "awaiting_approval"].includes(
              run.resumePhase ?? run.phase,
            )
          ) {
            const resumed = yield* update(service.resume(run.id))
            const result = yield* prompt({
              sessionID: input.sessionID,
              messageID: input.messageID,
              model: input.model ? Provider.parseModel(input.model) : undefined,
              agent: "compose",
              variant: input.variant,
              parts: [
                {
                  type: "text",
                  text: composeText(
                    `恢复 Compose 运行 ${resumed.id}，继续修订规格并请求审批，不得修改产品代码。`,
                    `Resume Compose run ${resumed.id}, continue revising the specification, and request approval. Do not modify product code.`,
                  ),
                },
              ],
            })
            let current = yield* saveSpec(yield* composeAsync(() => service.get(resumed.id)), result)
            if (current.phase === "orient")
              current = yield* update(service.transition({ id: current.id, phase: "grill" }))
            if (current.phase === "grill")
              current = yield* update(service.transition({ id: current.id, phase: "spec" }))
            if (current.phase === "spec")
              current = yield* update(service.transition({ id: current.id, phase: "awaiting_approval" }))
            if (current.phase === "brainstorm")
              current = yield* update(service.transition({ id: current.id, phase: "design" }))
            if (current.phase === "design")
              yield* update(service.transition({ id: current.id, phase: "awaiting_approval" }))
            return result
          }
          return yield* Effect.acquireUseRelease(
            composeAsync(() => service.recoverExecution(run.id)),
            (leased) =>
              Effect.gen(function* () {
                let resumed = leased.run
                if (!resumed.git.worktree) {
                  yield* composeAsync(() => service.assertExecutionLease(resumed.id, leased.lease))
                  const info = yield* composeAsync(() => createComposeWorkspace(resumed))
                  yield* composeAsync(() => service.assertExecutionLease(resumed.id, leased.lease))
                  resumed = yield* update(
                    service.update(resumed.id, "workspace-recovered", (current) => ({
                      ...current,
                      git: { ...current.git, branch: info.branch, worktree: info.directory },
                    }), leased.lease),
                  )
                }
                return yield* continueToFinish(
                  resumed,
                  composeText(
                    `恢复 Compose 运行 ${resumed.id}，从持久化阶段 ${resumed.phase} 继续。`,
                    `Resume Compose run ${resumed.id} from persisted phase ${resumed.phase}.`,
                  ),
                  leased.lease,
                )
              }),
            (leased) => composeAsync(() => leased.lease.release()).pipe(Effect.ignore),
          )
        }

        if (!tokens.includes("--confirmed")) {
          throw new Error(
            composeText(
              "Compose 收尾必须通过 Finish 弹窗明确选择，不能直接执行。",
              "Compose finish actions must be explicitly selected in the Finish dialog and cannot be invoked directly.",
            ),
          )
        }
        const finishAction = operation === "merge" ? "local_merge" : operation === "pr" ? "create_pr" : operation
        if (!["local_merge", "create_pr", "push", "keep", "discard"].includes(finishAction)) {
          throw new Error(
            composeText(`不支持的 Compose 收尾动作：${operation}`, `Unsupported Compose finish action: ${operation}`),
          )
        }
        return yield* Effect.acquireUseRelease(
          composeAsync(() => service.acquireFinishLease({ id: run.id, action: finishAction as Compose.FinishAction })),
          (leased) =>
            Effect.gen(function* () {
              const result = leased.needsGit
                ? yield* composeAsync(() => executeGitFinish(leased.run, leased.action))
                : leased.result
              if (!result) throw new Error(composeText("Compose 收尾结果缺失", "Compose finish result is missing"))
              if (leased.needsGit) {
                yield* update(
                  service.recordFinishGitResult({ id: leased.run.id, action: leased.action, ...result }, leased.lease),
                )
              }
              if (leased.needsCleanup && result.removeWorktree && leased.run.git.worktree) {
                yield* composeAsync(() =>
                  removeComposeWorkspace(leased.run, {
                    deleteBranch: result.deleteBranch,
                    force: result.forceRemove,
                  }),
                )
              }
              if (leased.needsCleanup) {
                yield* composeAsync(() => removeComposeTaskWorkspaces(leased.run))
                yield* update(service.recordFinishCleanup({ id: leased.run.id, action: leased.action }, leased.lease))
              }
              yield* update(service.finish({ id: leased.run.id, action: leased.action }, leased.lease))
              return yield* notice(result.message)
            }),
          (leased) => composeAsync(() => leased.lease.release()).pipe(Effect.ignore),
        )
      }

      if (
        WorkMeshProduct.enabled &&
        (input.command === Command.Default.LANGUAGE || input.command === Command.Default.LANG)
      ) {
        const value = input.arguments.trim()
        const normalized = WorkMeshLanguage.normalize(value)
        const current = yield* workmeshLanguage.get()
        const text = !value
          ? formatLanguageStatus(current)
          : !normalized
            ? formatUnsupportedLanguage(value, current)
            : formatLanguageChanged(yield* workmeshLanguage.set(normalized))
        return yield* prompt({
          sessionID: input.sessionID,
          messageID: input.messageID,
          agent: agentName,
          parts: [{ type: "text", text, synthetic: true }],
          noReply: true,
        })
      }

      if (WorkMeshProduct.enabled && input.command === Command.Default.LOOPS) {
        const value = input.arguments.trim().replace(/^(?:cancel|取消)\s+/i, "")
        if (value) {
          const job = yield* loops.resolve(input.sessionID, value)
          if (!job) throw new Error(`未找到循环任务：${value}`)
          yield* loops.remove(job.id)
          return yield* prompt({
            sessionID: input.sessionID,
            messageID: input.messageID,
            agent: agentName,
            parts: [{ type: "text", text: `已取消循环任务 ${job.id}。`, synthetic: true }],
            noReply: true,
          })
        }
        const jobs = yield* loops.list(input.sessionID)
        const text =
          jobs.length === 0
            ? "当前会话没有循环任务。"
            : [
                `当前会话共有 ${jobs.length} 个循环任务：`,
                ...jobs.map(
                  (job) =>
                    `- ${job.id} | 每 ${job.intervalSeconds} 秒 | 下次 ${formatLoopTime(job.nextRunAt)} | ${summarizeLoopPrompt(job.prompt)}`,
                ),
              ].join("\n")
        return yield* prompt({
          sessionID: input.sessionID,
          messageID: input.messageID,
          agent: agentName,
          parts: [{ type: "text", text, synthetic: true }],
          noReply: true,
        })
      }

      if (WorkMeshProduct.enabled && input.command === Command.Default.GOAL) {
        const condition = input.arguments.trim()
        if (condition === "" || condition === "clear" || condition === "reset" || condition === "取消") {
          yield* goal.clear(input.sessionID)
          return yield* prompt({
            sessionID: input.sessionID,
            messageID: input.messageID,
            agent: agentName,
            parts: [{ type: "text", text: "已取消当前 Goal。", synthetic: true }],
            noReply: true,
          })
        }
        yield* goal.set(input.sessionID, condition)
      }

      const raw = input.arguments.match(argsRegex) ?? []
      const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
      const templateCommand = yield* Effect.promise(async () => cmd.template)

      const placeholders = templateCommand.match(placeholderRegex) ?? []
      let last = 0
      for (const item of placeholders) {
        const value = Number(item.slice(1))
        if (value > last) last = value
      }

      const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
        const position = Number(index)
        const argIndex = position - 1
        if (argIndex >= args.length) return ""
        if (position === last) return args.slice(argIndex).join(" ")
        return args[argIndex]
      })
      const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
      let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

      if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
        template = template + "\n\n" + input.arguments
      }

      const shellMatches = ConfigMarkdown.shell(template)
      if (shellMatches.length > 0) {
        const cfg = yield* config.get()
        const sh = Shell.preferred(cfg.shell)
        const results = yield* Effect.promise(() =>
          Promise.all(
            shellMatches.map(async ([, cmd]) => (await Process.text([cmd], { shell: sh, nothrow: true })).text),
          ),
        )
        let index = 0
        template = template.replace(bashRegex, () => results[index++])
      }
      template = template.trim()

      const taskModel = yield* Effect.gen(function* () {
        if (cmd.model) return Provider.parseModel(cmd.model)
        if (cmd.agent) {
          const cmdAgent = yield* agents.get(cmd.agent)
          if (cmdAgent?.model) return cmdAgent.model
        }
        if (input.model) return Provider.parseModel(input.model)
        return yield* currentModel(input.sessionID)
      })

      yield* getModel(taskModel.providerID, taskModel.modelID, input.sessionID)

      const agent = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!agent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      if (WorkMeshProduct.enabled && input.command === Command.Default.LOOP) {
        yield* init()
        const parsed = parseLoopArguments(input.arguments)
        const job = yield* loops.createClaimed({
          sessionID: input.sessionID,
          prompt: parsed.prompt,
          intervalSeconds: parsed.intervalSeconds,
          agent: agent.name,
          model: taskModel,
        })
        const result = yield* executeLoopJob(job, input.messageID)
        if (!result) throw new Error(`循环任务在首次执行前已被取消：${job.id}`)
        yield* events.publish(Command.Event.Executed, {
          name: input.command,
          sessionID: input.sessionID,
          arguments: input.arguments,
          messageID: result.info.id,
        })
        return result
      }

      const templateParts = yield* resolvePromptParts(template)
      const inputFiles = new Set(
        input.parts?.filter((part) => new URL(part.url).protocol === "file:").map((part) => fileURLToPath(part.url)),
      )
      const uniqueTemplateParts = templateParts.filter(
        (part) => part.type !== "file" || !inputFiles.has(fileURLToPath(part.url)),
      )
      const isSubtask = (agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true
      const parts = isSubtask
        ? [
            {
              type: "subtask" as const,
              agent: agent.name,
              description: cmd.description ?? "",
              command: input.command,
              model: { providerID: taskModel.providerID, modelID: taskModel.modelID },
              prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
            },
          ]
        : [...uniqueTemplateParts, ...(input.parts ?? [])]

      const userAgent = isSubtask ? (input.agent ?? (yield* agents.defaultInfo()).name) : agent.name
      const userModel = isSubtask
        ? input.model
          ? Provider.parseModel(input.model)
          : yield* currentModel(input.sessionID)
        : taskModel

      yield* plugin.trigger(
        "command.execute.before",
        { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
        { parts },
      )

      const result = yield* prompt({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: userModel,
        agent: userAgent,
        parts,
        variant: input.variant,
      })
      yield* events.publish(Command.Event.Executed, {
        name: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        messageID: result.info.id,
      })
      return result
    })

    return Service.of({
      init,
      cancel,
      prompt,
      loop,
      shell,
      command,
      resolvePromptParts,
    })
  }),
)

const ModelRef = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
})

export const PromptInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  model: Schema.optional(ModelRef),
  agent: Schema.optional(Schema.String),
  noReply: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description:
      "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
  }),
  format: Schema.optional(SessionV1.Format),
  system: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  parts: Schema.Array(
    Schema.Union([
      SessionV1.TextPartInput,
      SessionV1.FilePartInput,
      SessionV1.AgentPartInput,
      SessionV1.SubtaskPartInput,
    ]).annotate({ discriminator: "type" }),
  ),
})
export type PromptInput = Schema.Schema.Type<typeof PromptInput>

export class LoopInput extends Schema.Class<LoopInput>("SessionPrompt.LoopInput")({
  sessionID: SessionID,
}) {}

export const ShellInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  agent: Schema.String,
  model: Schema.optional(ModelRef),
  command: Schema.String,
})
export type ShellInput = Schema.Schema.Type<typeof ShellInput>

export const CommandInput = Schema.Struct({
  messageID: Schema.optional(MessageID),
  sessionID: SessionID,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  arguments: Schema.String,
  command: Schema.String,
  variant: Schema.optional(Schema.String),
  // Inlined (no identifier annotation) to keep the original SDK output — the
  // PromptInput call site below references FilePartInput by ref via the
  // Schema export in message-v2.ts.
  parts: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.Struct({
          id: Schema.optional(PartID),
          type: Schema.Literal("file"),
          mime: Schema.String,
          filename: Schema.optional(Schema.String),
          url: Schema.String,
          source: Schema.optional(SessionV1.FilePartSource),
        }),
      ]).annotate({ discriminator: "type" }),
    ),
  ),
})
export type CommandInput = Schema.Schema.Type<typeof CommandInput>

function parseLoopArguments(value: string) {
  const input = value.trim()
  if (!input) throw new Error("循环任务内容不能为空。用法：/loop [60-3600秒] <任务>")
  const match = input.match(/^(\d+)(s|秒|m|分钟|h|小时)?(?:\s+)([\s\S]+)$/i)
  if (!match) return { intervalSeconds: WorkMeshLoops.DEFAULT_INTERVAL_SECONDS, prompt: input }
  const amount = Number(match[1])
  const unit = match[2]?.toLowerCase()
  const intervalSeconds =
    unit === "m" || unit === "分钟" ? amount * 60 : unit === "h" || unit === "小时" ? amount * 3600 : amount
  if (
    !Number.isInteger(intervalSeconds) ||
    intervalSeconds < WorkMeshLoops.MIN_INTERVAL_SECONDS ||
    intervalSeconds > WorkMeshLoops.MAX_INTERVAL_SECONDS
  ) {
    throw new Error(
      `循环周期必须在 ${WorkMeshLoops.MIN_INTERVAL_SECONDS} 到 ${WorkMeshLoops.MAX_INTERVAL_SECONDS} 秒之间`,
    )
  }
  return { intervalSeconds, prompt: match[3].trim() }
}

function formatLanguage(value: WorkMeshLanguage.Language, locale: WorkMeshCommandLocale.DisplayLocale) {
  if (locale === "en-US") {
    if (value === "zh-CN") return "Chinese (Simplified)"
    if (value === "en-US") return "English"
    return "Auto (follow the system language)"
  }
  if (value === "zh-CN") return "中文（简体中文）"
  if (value === "en-US") return "英文"
  return "自动（跟随系统语言）"
}

function formatLanguageStatus(value: WorkMeshLanguage.Language) {
  const locale = WorkMeshCommandLocale.resolve(value)
  if (locale === "en-US") {
    return `Current interface and response language: ${formatLanguage(value, locale)}.\nUsage: /language zh|en|auto (or /lang).`
  }
  return `当前界面与回复语言：${formatLanguage(value, locale)}。\n用法：/language 中文|英文|自动（也可使用 /lang）。`
}

function formatUnsupportedLanguage(value: string, current: WorkMeshLanguage.Language) {
  if (WorkMeshCommandLocale.resolve(current) === "en-US") {
    return `Unsupported language: "${value}". Available values: zh, en, auto.`
  }
  return `不支持的语言："${value}"。可选值：中文、英文、自动。`
}

function formatLanguageChanged(value: WorkMeshLanguage.Language) {
  const locale = WorkMeshCommandLocale.resolve(value)
  if (locale === "en-US") return `Interface and response language set to ${formatLanguage(value, locale)}.`
  return `界面与回复语言已设置为${formatLanguage(value, locale)}。`
}

function summarizeLoopPrompt(value: string) {
  const compact = value.replace(/\s+/g, " ").trim()
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact
}

function formatLoopTime(value: number) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false })
}

/** @internal Exported for testing */
export function createStructuredOutputTool(input: {
  schema: Record<string, any>
  onSuccess: (output: unknown) => void
}): AITool {
  // Remove $schema property if present (not needed for tool input)
  const { $schema: _, ...toolSchema } = input.schema

  return tool({
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    inputSchema: jsonSchema(toolSchema as JSONSchema7),
    async execute(args) {
      // AI SDK validates args against inputSchema before calling execute()
      input.onSuccess(args)
      return {
        output: "Structured output captured successfully.",
        title: "Structured Output",
        metadata: { valid: true },
      }
    },
    toModelOutput({ output }) {
      return {
        type: "text",
        value: output.output,
      }
    },
  })
}
const bashRegex = /!`([^`]+)`/g
// Match [Image N] as single token, quoted strings, or non-space sequences
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    SessionStatus.node,
    Session.node,
    Agent.node,
    Provider.node,
    SessionProcessor.node,
    SessionCompaction.node,
    Plugin.node,
    Command.node,
    Config.node,
    Permission.node,
    FSUtil.node,
    MCP.node,
    LSP.node,
    ToolRegistry.node,
    Truncate.node,
    Image.node,
    CrossSpawnSpawner.node,
    Instruction.node,
    SessionRunState.node,
    SessionRevert.node,
    SessionSummary.node,
    SystemPrompt.node,
    LLM.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
    Database.node,
    SessionGoal.node,
    WorkMeshLoops.node,
    WorkMeshLanguage.node,
  ],
})

export * as SessionPrompt from "./prompt"
