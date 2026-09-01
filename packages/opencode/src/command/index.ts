import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance-context"
import { Effect, Layer, Context, Schema } from "effect"
import { Config } from "@/config/config"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"
import { LegacyEvent } from "@opencode-ai/schema/legacy-event"

type State = {
  commands: Record<string, Info>
}

export const Event = {
  Executed: LegacyEvent.CommandExecuted,
}

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literals(["command", "mcp", "skill"])),
  // Some command templates are lazy promises from MCP prompt resolution.
  template: Schema.Unknown,
  subtask: Schema.optional(Schema.Boolean),
  hints: Schema.Array(Schema.String),
}).annotate({ identifier: "Command" })

export type Info = Omit<Schema.Schema.Type<typeof Info>, "template"> & { template: Promise<string> | string }

export function hints(template: string) {
  const result: string[] = []
  const numbered = template.match(/\$\d+/g)
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match)
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
  return result
}

export const Default = {
  INIT: "init",
  REVIEW: "review",
} as const

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Command") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const skill = yield* Skill.Service

    const init = Effect.fn("Command.state")(function* (ctx: InstanceContext) {
      const cfg = yield* config.get()
      const bridge = yield* EffectBridge.make()
      const commands: Record<string, Info> = {}

      commands[Default.INIT] = {
        name: Default.INIT,
        description: "guided AGENTS.md setup",
        source: "command",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", ctx.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      }
      commands[Default.REVIEW] = {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        source: "command",
        get template() {
          return PROMPT_REVIEW.replace("${path}", ctx.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      }

      for (const [name, command] of Object.entries(cfg.command ?? {})) {
        commands[name] = {
          name,
          agent: command.agent,
          model: command.model,
          description: command.description,
          source: "command",
          get template() {
            return command.template
          },
          subtask: command.subtask,
          hints: hints(command.template),
        }
      }

      for (const [name, prompt] of Object.entries(yield* mcp.prompts())) {
        commands[name] = {
          name,
          source: "mcp",
          description: prompt.description,
          get template() {
            return bridge.promise(
              mcp
                .getPrompt(
                  prompt.client,
                  prompt.name,
                  prompt.arguments
                    ? Object.fromEntries(prompt.arguments.map((argument, i) => [argument.name, `$${i + 1}`]))
                    : {},
                )
                .pipe(
                  Effect.map(
                    (template) =>
                      template?.messages
                        .map((message) => (message.content.type === "text" ? message.content.text : ""))
                        .join("\n") || "",
                  ),
                ),
            )
          },
          hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
        }
      }

      for (const item of yield* skill.all()) {
        if (commands[item.name]) continue
        const dir = item.location === "<built-in>" ? undefined : path.dirname(item.location)
        commands[item.name] = {
          name: item.name,
          description: item.description,
          source: "skill",
          get template() {
            if (!dir) return item.content
            return [
              item.content,
              "",
              `Base directory for this skill: ${dir}`,
              "Relative paths in this skill (e.g., scripts/, references/) are relative to this base directory.",
            ].join("\n")
          },
          hints: [],
        }
      }

      return {
        commands,
      }
    })

    const state = yield* InstanceState.make<State>((ctx) => init(ctx))

    const get = Effect.fn("Command.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.commands[name]
    })

    const list = Effect.fn("Command.list")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.commands)
    })

    return Service.of({ get, list })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [Config.node, MCP.node, Skill.node] })

export * as Command from "."
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance-context"
import { Effect, Layer, Context, Schema } from "effect"
import { Config } from "@/config/config"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"
import { LegacyEvent } from "@opencode-ai/schema/legacy-event"
import { WorkMeshLanguage } from "@/workmesh/language"
import { WorkMeshCommandLocale } from "@/workmesh/command-locale"

type State = {
  commands: Record<string, Info>
  localized: Set<string>
}

export const Event = {
  Executed: LegacyEvent.CommandExecuted,
}

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literals(["command", "mcp", "skill"])),
  // Some command templates are lazy promises from MCP prompt resolution.
  template: Schema.Unknown,
  subtask: Schema.optional(Schema.Boolean),
  hints: Schema.Array(Schema.String),
}).annotate({ identifier: "Command" })

export type Info = Omit<Schema.Schema.Type<typeof Info>, "template"> & { template: Promise<string> | string }

export function hints(template: string) {
  const result: string[] = []
  const numbered = template.match(/\$\d+/g)
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match)
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
  return result
}

export const Default = {
  INIT: "init",
  REVIEW: "review",
  GOAL: "goal",
  LOOP: "loop",
  LOOPS: "loops",
  LANGUAGE: "language",
  LANG: "lang",
  TERMINALS: "terminals",
  MESSAGE: "message",
  MESSAGES: "messages",
  COMPOSE: "compose",
  COMPOSE_NEXT: "compose-next",
} as const

const WORKMESH_RESERVED = new Set<string>([
  Default.GOAL,
  Default.LOOP,
  Default.LOOPS,
  Default.LANGUAGE,
  Default.LANG,
  Default.TERMINALS,
  Default.MESSAGE,
  Default.MESSAGES,
  Default.COMPOSE,
  Default.COMPOSE_NEXT,
])

function isWorkMeshReserved(name: string) {
  return WORKMESH_RESERVED.has(name)
}

function localize(command: Info, language: WorkMeshLanguage.Language) {
  const locale = WorkMeshCommandLocale.resolve(language)
  const description = WorkMeshCommandLocale.description(command.name, command.description, locale)
  return description === command.description ? command : { ...command, description }
}

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Command") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const skill = yield* Skill.Service
    const language = yield* WorkMeshLanguage.Service

    const init = Effect.fn("Command.state")(function* (ctx: InstanceContext) {
      const cfg = yield* config.get()
      const bridge = yield* EffectBridge.make()
      const commands: Record<string, Info> = {}
      const localized = new Set<string>()

      commands[Default.INIT] = {
        name: Default.INIT,
        description: "guided AGENTS.md setup",
        source: "command",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", ctx.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      }
      commands[Default.REVIEW] = {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        source: "command",
        get template() {
          return PROMPT_REVIEW.replace("${path}", ctx.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      }
        localized
          .add(Default.INIT)
          .add(Default.REVIEW)
          .add(Default.GOAL)
          .add(Default.LOOP)
          .add(Default.LOOPS)
          .add(Default.LANGUAGE)
          .add(Default.LANG)
          .add(Default.TERMINALS)
          .add(Default.MESSAGE)
          .add(Default.MESSAGES)
          .add(Default.COMPOSE)
          .add(Default.COMPOSE_NEXT)
        commands[Default.GOAL] = {
          name: Default.GOAL,
          description: "设置停止条件并持续执行，直到独立检查通过；使�?/goal clear 取消",
          source: "command",
          subtask: false,
          get template() {
            return "$ARGUMENTS"
          },
          hints: ["$ARGUMENTS"],
        }
        commands[Default.LOOP] = {
          name: Default.LOOP,
          description: "按周期持续执行任务：/loop [5-3600秒] <任务>",
          source: "command",
          subtask: false,
          get template() {
            return "$ARGUMENTS"
          },
          hints: ["$ARGUMENTS"],
        }
        commands[Default.LOOPS] = {
          name: Default.LOOPS,
          description: "查看循环任务；使�?/loops <ID前缀> 取消",
          source: "command",
          subtask: false,
          get template() {
            return "$ARGUMENTS"
          },
          hints: ["$ARGUMENTS"],
        }
        commands[Default.LANGUAGE] = {
          name: Default.LANGUAGE,
          description: "设置回复语言：中文、英文或自动",
          source: "command",
          subtask: false,
          get template() {
            return "$ARGUMENTS"
          },
          hints: ["$ARGUMENTS"],
        }
        commands[Default.LANG] = {
          name: Default.LANG,
          description: "设置回复语言�?language 的简写）",
          source: "command",
          subtask: false,
          get template() {
            return "$ARGUMENTS"
          },
          hints: ["$ARGUMENTS"],
        }
        commands[Default.TERMINALS] = {
          name: Default.TERMINALS,
          description: "查看当前项目中可通信的终�?,
          source: "command",
          subtask: false,
          get template() {
            return "$ARGUMENTS"
          },
          hints: ["$ARGUMENTS"],
        }
        commands[Default.MESSAGE] = {
          name: Default.MESSAGE,
          description: "向指�?Agent 发送短消息�?message <终端ID> <消息>",
          source: "command",
          subtask: false,
          get template() {
            return "$ARGUMENTS"
          },
          hints: ["$ARGUMENTS"],
        }
        commands[Default.MESSAGES] = {
          name: Default.MESSAGES,
          description: "查看当前终端收到的未读消�?,
          source: "command",
          subtask: false,
          get template() {
            return "$ARGUMENTS"
          },
          hints: ["$ARGUMENTS"],
        }
        commands[Default.COMPOSE] = {
          name: Default.COMPOSE,
          description: "启动、审批、恢复或完成可持久化 Compose 工作�?,
          source: "command",
          subtask: false,
          get template() {
            return "$ARGUMENTS"
          },
          hints: ["$ARGUMENTS"],
        }
        commands[Default.COMPOSE_NEXT] = {
          name: Default.COMPOSE_NEXT,
          description: "使用规格驱动的交互式 Compose 流程完成复杂任务",
          source: "command",
          agent: "compose",
          subtask: false,
          get template() {
            return [
              "Load and follow the `compose-next` skill for this request.",
              "The skill is user-invoked, so continue through its Orient and Grill stages.",
              "Task: $ARGUMENTS",
            ].join("\n")
          },
          hints: ["$ARGUMENTS"],
        }

      for (const [name, command] of Object.entries(cfg.command ?? {})) {
        if (isWorkMeshReserved(name)) continue
        localized.delete(name)
        commands[name] = {
          name,
          agent: command.agent,
          model: command.model,
          description: command.description,
          source: "command",
          get template() {
            return command.template
          },
          subtask: command.subtask,
          hints: hints(command.template),
        }
      }

      for (const [name, prompt] of Object.entries(yield* mcp.prompts())) {
        if (isWorkMeshReserved(name)) continue
        localized.delete(name)
        commands[name] = {
          name,
          source: "mcp",
          description: prompt.description,
          get template() {
            return bridge.promise(
              mcp
                .getPrompt(
                  prompt.client,
                  prompt.name,
                  prompt.arguments
                    ? Object.fromEntries(prompt.arguments.map((argument, i) => [argument.name, `$${i + 1}`]))
                    : {},
                )
                .pipe(
                  Effect.map(
                    (template) =>
                      template?.messages
                        .map((message) => (message.content.type === "text" ? message.content.text : ""))
                        .join("\n") || "",
                  ),
                ),
            )
          },
          hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
        }
      }

      for (const item of yield* skill.all()) {
        if (commands[item.name]) continue
        localized.add(item.name)
        const dir = item.location === "<built-in>" ? undefined : path.dirname(item.location)
        commands[item.name] = {
          name: item.name,
          description: item.description,
          source: "skill",
          get template() {
            if (!dir) return item.content
            return [
              item.content,
              "",
              `Base directory for this skill: ${dir}`,
              "Relative paths in this skill (e.g., scripts/, references/) are relative to this base directory.",
            ].join("\n")
          },
          hints: [],
        }
      }

      return {
        commands,
        localized,
      }
    })

    const state = yield* InstanceState.make<State>((ctx) => init(ctx))

    const get = Effect.fn("Command.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      const command = s.commands[name]
      if (!command || !s.localized.has(name)) return command
      return localize(command, yield* language.get())
    })

    const list = Effect.fn("Command.list")(function* () {
      const s = yield* InstanceState.get(state)
      const commands = Object.values(s.commands)
      const current = yield* language.get()
      return commands.map((command) => (s.localized.has(command.name) ? localize(command, current) : command))
    })

    return Service.of({ get, list })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, MCP.node, Skill.node, WorkMeshLanguage.node],
})

export * as Command from "."
