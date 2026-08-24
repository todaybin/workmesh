import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { WorkMeshLanguage } from "@/workmesh/language"
import { provideInstance, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(WorkMeshLanguage.node))

it.instance(
  "persists the reply language inside the current project",
  () =>
    Effect.gen(function* () {
      const language = yield* WorkMeshLanguage.Service
      const test = yield* TestInstance

      expect(yield* language.get()).toBe("zh-CN")
      expect(yield* language.set("中文")).toBe("zh-CN")
      expect(yield* language.get()).toBe("zh-CN")

      const file = path.join(test.directory, ".workmesh", "config", "language.json")
      const saved = JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8")))
      expect(saved).toEqual({ schemaVersion: "workmesh.language.v1", language: "zh-CN" })
    }),
  { git: true },
)

it.effect("normalizes supported language aliases", () =>
  Effect.sync(() => {
    expect(WorkMeshLanguage.normalize(" zh ")).toBe("zh-CN")
    expect(WorkMeshLanguage.normalize("简体中文")).toBe("zh-CN")
    expect(WorkMeshLanguage.normalize("EN_us")).toBe("en-US")
    expect(WorkMeshLanguage.normalize("英语")).toBe("en-US")
    expect(WorkMeshLanguage.normalize("reset")).toBe("auto")
    expect(WorkMeshLanguage.normalize("自动")).toBe("auto")
  }),
)

it.effect("resolves auto from the system locale", () =>
  Effect.sync(() => {
    expect(WorkMeshLanguage.resolve("auto", "zh-Hans-CN")).toBe("zh-CN")
    expect(WorkMeshLanguage.resolve("auto", "en-GB")).toBe("en-US")
    expect(WorkMeshLanguage.resolve("zh-CN", "en-US")).toBe("zh-CN")
  }),
)

it.effect("instructs the model to use the selected language for all visible narrative", () =>
  Effect.sync(() => {
    const chinese = WorkMeshLanguage.systemPrompt("zh-CN")
    expect(chinese).toContain("当前语言为简体中文")
    expect(chinese).toContain("可见推理或推理摘要")
    expect(chinese).toContain("工具调用的自然语言标题与描述")
    expect(chinese).toContain("子 Agent")
    expect(chinese).toContain("Compose")
    expect(chinese).toContain("原始日志")

    const english = WorkMeshLanguage.systemPrompt("en-US")
    expect(english).toContain("The current language is English")
    expect(english).toContain("visible reasoning or reasoning summaries")
    expect(english).toContain("raw logs")

    expect(WorkMeshLanguage.systemPrompt("auto", "zh-CN")).toBe(chinese)
    expect(WorkMeshLanguage.systemPrompt("auto", "en-US")).toBe(english)
  }),
)

it.instance(
  "resets an explicit language preference to auto",
  () =>
    Effect.gen(function* () {
      const language = yield* WorkMeshLanguage.Service
      const test = yield* TestInstance

      yield* language.set("en-US")
      expect(yield* language.set("auto")).toBe("auto")
      expect(yield* language.get()).toBe("auto")

      const saved = JSON.parse(
        yield* Effect.promise(() =>
          fs.readFile(path.join(test.directory, ".workmesh", "config", "language.json"), "utf8"),
        ),
      )
      expect(saved.language).toBe("auto")
    }),
  { git: true },
)

it.instance(
  "rejects unsupported language values without changing the saved preference",
  () =>
    Effect.gen(function* () {
      const language = yield* WorkMeshLanguage.Service
      yield* language.set("中文")

      const exit = yield* language.set("fr-FR").pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("不支持的 WorkMesh 回复语言")
      expect(yield* language.get()).toBe("zh-CN")
    }),
  { git: true },
)

it.instance(
  "isolates language preferences between project instances",
  () =>
    Effect.gen(function* () {
      const language = yield* WorkMeshLanguage.Service
      const test = yield* TestInstance
      const first = test.directory
      const second = path.join(test.directory, "second-project")
      yield* Effect.promise(async () => {
        await fs.mkdir(second)
        await Bun.$`git init`.cwd(second).quiet()
      })

      yield* language.set("中文").pipe(provideInstance(first))
      yield* language.set("英文").pipe(provideInstance(second))

      expect(yield* language.get().pipe(provideInstance(first))).toBe("zh-CN")
      expect(yield* language.get().pipe(provideInstance(second))).toBe("en-US")
    }),
  { git: true },
)

it.instance(
  "stores a subdirectory preference at the Git project root",
  () =>
    Effect.gen(function* () {
      const language = yield* WorkMeshLanguage.Service
      const test = yield* TestInstance
      const nested = path.join(test.directory, "packages", "app")
      yield* Effect.promise(() => fs.mkdir(nested, { recursive: true }))

      yield* language.set("英文").pipe(provideInstance(nested))

      const saved = JSON.parse(
        yield* Effect.promise(() =>
          fs.readFile(path.join(test.directory, ".workmesh", "config", "language.json"), "utf8"),
        ),
      )
      expect(saved.language).toBe("en-US")
    }),
  { git: true },
)
