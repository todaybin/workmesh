import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Flock } from "@opencode-ai/core/util/flock"
import { WorkMeshRuntimeLayout } from "@opencode-ai/core/workmesh/runtime-layout"
import { Context, Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { InstanceState } from "@/effect/instance-state"

export type Language = "auto" | "zh-CN" | "en-US"
export type ResolvedLanguage = Exclude<Language, "auto">

type State = {
  file: string
  lockDir: string
}

const DEFAULT_LANGUAGE: Language = "zh-CN"

export function normalize(value: string): Language | undefined {
  const input = value.trim().toLowerCase()
  if (["auto", "reset", "自动"].includes(input)) return "auto"
  if (["zh", "zh-cn", "zh_cn", "中文", "简体中文"].includes(input)) return "zh-CN"
  if (["en", "en-us", "en_us", "英文", "英语"].includes(input)) return "en-US"
}

export function resolve(
  language: Language,
  systemLocale = Intl.DateTimeFormat().resolvedOptions().locale,
): ResolvedLanguage {
  if (language !== "auto") return language
  return systemLocale.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US"
}

export function systemPrompt(language: Language, systemLocale?: string) {
  if (resolve(language, systemLocale) === "zh-CN") {
    return [
      "当前语言为简体中文。",
      "所有面向用户的自然语言内容都必须直接使用简体中文生成，包括最终回复、过程说明、可见推理或推理摘要、工具调用的自然语言标题与描述、子 Agent 的任务说明与完成摘要，以及 Compose 规格、阶段报告和交付文档。",
      "代码、命令、路径、配置键、协议字段、原始日志、第三方错误和确有必要保留的技术术语保持原文，不要为了中文化而改写这些技术内容。",
    ].join(" ")
  }
  return [
    "The current language is English.",
    "Generate all user-visible natural-language content directly in English, including final responses, progress updates, visible reasoning or reasoning summaries, natural-language tool titles and descriptions, subagent task instructions and completion summaries, and Compose specifications, stage reports, and delivery documents.",
    "Keep code, commands, paths, configuration keys, protocol fields, raw logs, third-party errors, and technical terms that must remain exact in their original form.",
  ].join(" ")
}

async function read(file: string) {
  const contents = await fs.readFile(file, "utf8").catch((error) => {
    if (isCode(error, "ENOENT")) return undefined
    throw error
  })
  if (contents === undefined) return DEFAULT_LANGUAGE
  const parsed = JSON.parse(contents) as { language?: unknown }
  if (parsed.language === "auto" || parsed.language === "zh-CN" || parsed.language === "en-US") {
    return parsed.language
  }
  throw new Error(`无效的 WorkMesh 回复语言配置：${String(parsed.language)}`)
}

export function readForRoot(root: string) {
  return read(path.join(WorkMeshRuntimeLayout.layoutForRoot(root).config, "language.json"))
}

async function write(file: string, language: Language) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs
    .writeFile(temporary, JSON.stringify({ schemaVersion: "workmesh.language.v1", language }, undefined, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
    })
    .then(() => fs.rename(temporary, file))
    .catch(async (error) => {
      await fs.rm(temporary, { force: true })
      throw error
    })
}

function isCode(error: unknown, expected: string) {
  return typeof error === "object" && error !== null && "code" in error && error.code === expected
}

export interface Interface {
  readonly get: () => Effect.Effect<Language>
  readonly set: (value: string) => Effect.Effect<Language>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkMeshLanguage") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make<State>((ctx) =>
      Effect.sync(() => {
        const layout = WorkMeshRuntimeLayout.layoutForRoot(ctx.worktree === "/" ? ctx.directory : ctx.worktree)
        return {
          file: path.join(layout.config, "language.json"),
          lockDir: layout.locks,
        }
      }),
    )

    const get = Effect.fn("WorkMeshLanguage.get")(function* () {
      const data = yield* InstanceState.get(state)
      return yield* Effect.tryPromise({
        try: () => read(data.file),
        catch: (error) => new Error(`无法读取 WorkMesh 回复语言：${String(error)}`),
      }).pipe(Effect.orDie)
    })

    const set = Effect.fn("WorkMeshLanguage.set")(function* (value: string) {
      const language = normalize(value)
      if (!language) return yield* Effect.die(new Error(`不支持的 WorkMesh 回复语言：${value}`))
      return yield* Effect.gen(function* () {
        const data = yield* InstanceState.get(state)
        yield* Flock.effect(`workmesh-language:${data.file}`, {
          dir: data.lockDir,
          staleMs: 30_000,
          timeoutMs: 30_000,
        })
        yield* Effect.tryPromise({
          try: () => write(data.file, language),
          catch: (error) => new Error(`无法保存 WorkMesh 回复语言：${String(error)}`),
        }).pipe(Effect.orDie)
        return language
      }).pipe(Effect.scoped)
    })

    return Service.of({ get, set })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as WorkMeshLanguage from "./language"
