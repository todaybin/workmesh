import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { WorkMeshLoops } from "@/session/loops"
import { SessionID } from "@/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(WorkMeshLoops.node))
const sessionID = SessionID.make("ses_loop_test")
const model = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

function create(loops: WorkMeshLoops.Interface, prompt: string, targetSessionID = sessionID) {
  return loops.create({
    sessionID: targetSessionID,
    prompt,
    intervalSeconds: 60,
    agent: "build",
    model,
  })
}

it.instance("persists jobs inside the current project and prunes expired records", () =>
  Effect.gen(function* () {
    const loops = yield* WorkMeshLoops.Service
    const test = yield* TestInstance
    const job = yield* create(loops, "检查构建状态")
    const file = path.join(test.directory, ".workmesh", "state", "workmesh-loops.json")
    const saved = JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8")))

    expect(saved.jobs[job.id].prompt).toBe("检查构建状态")

    saved.jobs[job.id].expiresAt = Date.now() - 1
    yield* Effect.promise(() => fs.writeFile(file, JSON.stringify(saved), "utf8"))
    expect(yield* loops.list(sessionID)).toEqual([])

    const pruned = JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8")))
    expect(pruned.jobs).toEqual({})
  }),
)

it.instance("claims at most one due job per session", () =>
  Effect.gen(function* () {
    const loops = yield* WorkMeshLoops.Service
    const first = yield* create(loops, "任务一")
    const second = yield* create(loops, "任务二")
    const now = Date.now() + 1_000

    const claimed = yield* loops.claimDue(now)
    expect(claimed).toHaveLength(1)
    expect([first.id, second.id]).toContain(claimed[0].id)
    expect(yield* loops.claimDue(now)).toEqual([])

    yield* loops.completeTick(claimed[0].id, true, now)
    const next = yield* loops.claimDue(now)
    expect(next).toHaveLength(1)
    expect(next[0].id).not.toBe(claimed[0].id)
  }),
)

it.instance("advances an overdue job once instead of replaying every missed period", () =>
  Effect.gen(function* () {
    const loops = yield* WorkMeshLoops.Service
    const job = yield* create(loops, "补执行一次")
    const recoveredAt = Date.now() + 4 * 60 * 60 * 1000

    const claimed = yield* loops.claimDue(recoveredAt)
    expect(claimed.map((item) => item.id)).toEqual([job.id])
    expect(claimed[0].nextRunAt).toBe(recoveredAt + 60_000)
    expect(yield* loops.claimDue(recoveredAt)).toEqual([])
  }),
)

it.instance("allows one keepalive retry before returning to the normal interval", () =>
  Effect.gen(function* () {
    const loops = yield* WorkMeshLoops.Service
    const job = yield* create(loops, "失败重试")
    const firstRun = Date.now() + 1_000
    expect((yield* loops.claim(job.id, firstRun))?.id).toBe(job.id)

    const keepalive = yield* loops.completeTick(job.id, false, firstRun)
    expect(keepalive?.keepaliveUsed).toBe(1)
    expect(keepalive?.nextRunAt).toBe(firstRun + WorkMeshLoops.KEEPALIVE_DELAY_SECONDS * 1000)

    const retryAt = keepalive!.nextRunAt
    expect((yield* loops.claim(job.id, retryAt))?.id).toBe(job.id)
    const normal = yield* loops.completeTick(job.id, false, retryAt)
    expect(normal?.keepaliveUsed).toBe(0)
    expect(normal?.nextRunAt).toBe(retryAt + job.intervalSeconds * 1000)
  }),
)

it.instance("rejects ambiguous ID prefixes and removes exact matches", () =>
  Effect.gen(function* () {
    const loops = yield* WorkMeshLoops.Service
    const first = yield* create(loops, "任务一")
    yield* create(loops, "任务二")

    const ambiguous = yield* loops.resolve(sessionID, "loop-").pipe(Effect.exit)
    expect(ambiguous._tag).toBe("Failure")
    expect((yield* loops.resolve(sessionID, first.id.slice(0, -1)))?.id).toBe(first.id)
    expect(yield* loops.remove(first.id)).toBe(true)
    expect(yield* loops.get(first.id)).toBeUndefined()
  }),
)
