import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import path from "node:path"
import fs from "node:fs/promises"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import * as Tool from "@/tool/tool"
import { WriteTool } from "@/tool/write"
import { EditTool } from "@/tool/edit"
import { ApplyPatchTool } from "@/tool/apply_patch"
import { MessageID, SessionID } from "@/session/schema"
import { TestInstance, disposeAllInstances } from "../fixture/fixture"
import { testEffect, awaitWithTimeout } from "../lib/effect"

const layer = LayerNode.compile(
  LayerNode.group([
    LSP.node,
    FSUtil.node,
    EventV2Bridge.node,
    Format.node,
    CrossSpawnSpawner.node,
    Truncate.node,
    Agent.node,
  ]),
)

const it = testEffect(layer)

const baseContext: Omit<Tool.Context, "sessionID" | "ask"> = {
  messageID: MessageID.make("msg_workmesh-write-intent"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

const makeContext = (
  id: string,
  ask: Tool.Context["ask"] = () => Effect.void,
): Tool.Context => ({
  ...baseContext,
  sessionID: SessionID.make(`ses_workmesh-${id}`),
  ask,
})

const withWorkMesh = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = {
        build: process.env.WORKMESH_BUILD,
        url: process.env.WORKMESH_GATEWAY_URL,
        token: process.env.WORKMESH_GATEWAY_TOKEN,
        project: process.env.WORKMESH_PROJECT_ID,
      }
      process.env.WORKMESH_BUILD = "1"
      delete process.env.WORKMESH_GATEWAY_URL
      delete process.env.WORKMESH_GATEWAY_TOKEN
      delete process.env.WORKMESH_PROJECT_ID
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous.build === undefined) delete process.env.WORKMESH_BUILD
        else process.env.WORKMESH_BUILD = previous.build
        if (previous.url === undefined) delete process.env.WORKMESH_GATEWAY_URL
        else process.env.WORKMESH_GATEWAY_URL = previous.url
        if (previous.token === undefined) delete process.env.WORKMESH_GATEWAY_TOKEN
        else process.env.WORKMESH_GATEWAY_TOKEN = previous.token
        if (previous.project === undefined) delete process.env.WORKMESH_PROJECT_ID
        else process.env.WORKMESH_PROJECT_ID = previous.project
      }),
  )

const expectConflict = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("WorkMesh 写入冲突")
  })

afterEach(async () => {
  await disposeAllInstances()
})

describe("WorkMesh 写入意图与工具冲突保护", () => {
  it.instance("write 在实际写入前拒绝冲突，并在释放后允许再次写入", () =>
    withWorkMesh(
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const filePath = path.join(instance.directory, "shared.txt")
        yield* Effect.promise(() => fs.writeFile(filePath, "initial", "utf8"))
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const firstContext = makeContext("write-first", () =>
          Effect.sync(() => Deferred.doneUnsafe(started, Effect.void)).pipe(Effect.andThen(Deferred.await(release))),
        )
        const secondContext = makeContext("write-second")
        const info = yield* WriteTool
        const tool = yield* info.init()
        const first = yield* tool.execute({ filePath, content: "first" }, firstContext).pipe(Effect.forkScoped)
        yield* awaitWithTimeout(Deferred.await(started), "write 工具未进入权限确认")
        yield* expectConflict(tool.execute({ filePath, content: "second" }, secondContext))
        expect(yield* Effect.promise(() => fs.readFile(filePath, "utf8"))).toBe("initial")
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(first)
        expect(yield* Effect.promise(() => fs.readFile(filePath, "utf8"))).toBe("first")
        yield* tool.execute({ filePath, content: "second" }, secondContext)
        expect(yield* Effect.promise(() => fs.readFile(filePath, "utf8"))).toBe("second")
      }),
    ),
  )

  it.instance("edit 在冲突时不写入，首个租约释放后可继续编辑", () =>
    withWorkMesh(
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const filePath = path.join(instance.directory, "shared.txt")
        yield* Effect.promise(() => fs.writeFile(filePath, "initial", "utf8"))
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const firstContext = makeContext("edit-first", () =>
          Effect.sync(() => Deferred.doneUnsafe(started, Effect.void)).pipe(Effect.andThen(Deferred.await(release))),
        )
        const secondContext = makeContext("edit-second")
        const info = yield* EditTool
        const tool = yield* info.init()
        const first = yield* tool.execute({ filePath, oldString: "initial", newString: "first" }, firstContext).pipe(Effect.forkScoped)
        yield* awaitWithTimeout(Deferred.await(started), "edit 工具未进入权限确认")
        yield* expectConflict(tool.execute({ filePath, oldString: "initial", newString: "second" }, secondContext))
        expect(yield* Effect.promise(() => fs.readFile(filePath, "utf8"))).toBe("initial")
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(first)
        expect(yield* Effect.promise(() => fs.readFile(filePath, "utf8"))).toBe("first")
        yield* tool.execute({ filePath, oldString: "first", newString: "second" }, secondContext)
        expect(yield* Effect.promise(() => fs.readFile(filePath, "utf8"))).toBe("second")
      }),
    ),
  )

  it.instance("apply_patch 在冲突时不写入并正确释放多文件租约", () =>
    withWorkMesh(
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const filePath = path.join(instance.directory, "shared.txt")
        yield* Effect.promise(() => fs.writeFile(filePath, "initial\n", "utf8"))
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const firstContext = makeContext("patch-first", () =>
          Effect.sync(() => Deferred.doneUnsafe(started, Effect.void)).pipe(Effect.andThen(Deferred.await(release))),
        )
        const secondContext = makeContext("patch-second")
        const info = yield* ApplyPatchTool
        const tool = yield* info.init()
        const patch = (from: string, to: string) =>
          `*** Begin Patch\n*** Update File: shared.txt\n@@\n-${from}\n+${to}\n*** End Patch`
        const first = yield* tool.execute({ patchText: patch("initial", "first") }, firstContext).pipe(Effect.forkScoped)
        yield* awaitWithTimeout(Deferred.await(started), "apply_patch 工具未进入权限确认")
        yield* expectConflict(tool.execute({ patchText: patch("initial", "second") }, secondContext))
        expect(yield* Effect.promise(() => fs.readFile(filePath, "utf8"))).toBe("initial\n")
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(first)
        expect(yield* Effect.promise(() => fs.readFile(filePath, "utf8"))).toBe("first\n")
        yield* tool.execute({ patchText: patch("first", "second") }, secondContext)
        expect(yield* Effect.promise(() => fs.readFile(filePath, "utf8"))).toBe("second\n")
      }),
    ),
  )
})
