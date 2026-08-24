import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Flock } from "@opencode-ai/core/util/flock"
import { WorkMeshRuntimeLayout } from "@opencode-ai/core/workmesh/runtime-layout"
import { Context, Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { InstanceState } from "@/effect/instance-state"
import type { SessionID } from "./schema"
import type { ModelV2 } from "@opencode-ai/core/model"
import type { ProviderV2 } from "@opencode-ai/core/provider"

export const MIN_INTERVAL_SECONDS = 60
export const MAX_INTERVAL_SECONDS = 3600
export const DEFAULT_INTERVAL_SECONDS = 600
export const KEEPALIVE_DELAY_SECONDS = 1200
export const MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000

export type LoopJob = {
  id: string
  sessionID: SessionID
  prompt: string
  intervalSeconds: number
  agent: string
  model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  createdAt: number
  nextRunAt: number
  expiresAt: number
  keepaliveUsed: number
}

type State = {
  file: string
  lockDir: string
  runningJobs: Map<string, SessionID>
  runningSessions: Set<SessionID>
}

async function loadJobs(file: string, now: number) {
  const text = await fs.readFile(file, "utf8").catch((error) => {
    if (isCode(error, "ENOENT")) return ""
    throw error
  })
  if (!text) return { jobs: new Map<string, LoopJob>(), pruned: false }
  const parsed = JSON.parse(text) as { jobs?: Record<string, LoopJob> }
  const entries = Object.entries(parsed.jobs ?? {})
  const valid = entries.filter(([, job]) => validJob(job, now))
  return { jobs: new Map(valid), pruned: valid.length !== entries.length }
}

async function saveJobs(file: string, jobs: Map<string, LoopJob>) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    temporary,
    JSON.stringify({ schemaVersion: "workmesh.loops.v1", jobs: Object.fromEntries(jobs) }),
    "utf8",
  )
  await fs.rename(temporary, file)
}

function validJob(job: LoopJob | undefined, now: number): job is LoopJob {
  return (
    typeof job?.id === "string" &&
    typeof job.sessionID === "string" &&
    typeof job.prompt === "string" &&
    job.prompt.trim() !== "" &&
    typeof job.agent === "string" &&
    typeof job.model?.providerID === "string" &&
    typeof job.model.modelID === "string" &&
    Number.isInteger(job.intervalSeconds) &&
    job.intervalSeconds >= MIN_INTERVAL_SECONDS &&
    job.intervalSeconds <= MAX_INTERVAL_SECONDS &&
    Number.isFinite(job.createdAt) &&
    Number.isFinite(job.nextRunAt) &&
    Number.isFinite(job.expiresAt) &&
    job.expiresAt > now &&
    (job.keepaliveUsed === 0 || job.keepaliveUsed === 1)
  )
}

function isCode(error: unknown, expected: string) {
  return typeof error === "object" && error !== null && "code" in error && error.code === expected
}

export interface Interface {
  readonly create: (
    input: Omit<LoopJob, "id" | "createdAt" | "nextRunAt" | "expiresAt" | "keepaliveUsed">,
  ) => Effect.Effect<LoopJob>
  readonly createClaimed: (
    input: Omit<LoopJob, "id" | "createdAt" | "nextRunAt" | "expiresAt" | "keepaliveUsed">,
  ) => Effect.Effect<LoopJob>
  readonly get: (id: string) => Effect.Effect<LoopJob | undefined>
  readonly list: (sessionID: SessionID) => Effect.Effect<LoopJob[]>
  readonly remove: (id: string) => Effect.Effect<boolean>
  readonly resolve: (sessionID: SessionID, idOrPrefix: string) => Effect.Effect<LoopJob | undefined>
  readonly claim: (id: string, now?: number) => Effect.Effect<LoopJob | undefined>
  readonly claimDue: (now?: number) => Effect.Effect<LoopJob[]>
  readonly completeTick: (id: string, succeeded: boolean, now?: number) => Effect.Effect<LoopJob | undefined>
  readonly withSessionLock: <A, E, R>(sessionID: SessionID, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkMeshLoops") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make<State>((ctx) =>
      Effect.sync(() => {
        const layout = WorkMeshRuntimeLayout.layoutForRoot(ctx.directory)
        return {
          file: path.join(layout.state, "workmesh-loops.json"),
          lockDir: layout.locks,
          runningJobs: new Map(),
          runningSessions: new Set(),
        }
      }),
    )

    const withJobs = <A>(
      name: string,
      now: number,
      mutate: (jobs: Map<string, LoopJob>, data: State) => { value: A; changed: boolean },
    ) =>
      Effect.gen(function* () {
        const data = yield* InstanceState.get(state)
        yield* Flock.effect(`workmesh-loops:${data.file}`, {
          dir: data.lockDir,
          staleMs: 30_000,
          timeoutMs: 30_000,
        })
        const loaded = yield* Effect.tryPromise({
          try: () => loadJobs(data.file, now),
          catch: (error) => new Error(`无法读取 WorkMesh 循环任务：${String(error)}`),
        })
        const result = mutate(loaded.jobs, data)
        if (loaded.pruned || result.changed) {
          yield* Effect.tryPromise({
            try: () => saveJobs(data.file, loaded.jobs),
            catch: (error) => new Error(`无法保存 WorkMesh 循环任务：${String(error)}`),
          })
        }
        return result.value
      }).pipe(Effect.scoped, Effect.withSpan(name), Effect.orDie)

    const makeJob = (
      input: Omit<LoopJob, "id" | "createdAt" | "nextRunAt" | "expiresAt" | "keepaliveUsed">,
      claimed: boolean,
    ) => {
      if (!Number.isInteger(input.intervalSeconds)) throw new Error("循环周期必须是整数秒")
      if (input.intervalSeconds < MIN_INTERVAL_SECONDS || input.intervalSeconds > MAX_INTERVAL_SECONDS) {
        throw new Error(`循环周期必须在 ${MIN_INTERVAL_SECONDS} 到 ${MAX_INTERVAL_SECONDS} 秒之间`)
      }
      if (!input.prompt.trim()) throw new Error("循环任务内容不能为空")
      const now = Date.now()
      const job: LoopJob = {
        ...input,
        prompt: input.prompt.trim(),
        id: `loop-${randomUUID().slice(0, 8)}`,
        createdAt: now,
        nextRunAt: now + (claimed ? input.intervalSeconds * 1000 : 0),
        expiresAt: now + MAX_LIFETIME_MS,
        keepaliveUsed: 0,
      }
      return { job, now }
    }

    const create = Effect.fn("WorkMeshLoops.create")(function* (
      input: Omit<LoopJob, "id" | "createdAt" | "nextRunAt" | "expiresAt" | "keepaliveUsed">,
    ) {
      const created = makeJob(input, false)
      return yield* withJobs("WorkMeshLoops.createLocked", created.now, (jobs) => {
        jobs.set(created.job.id, created.job)
        return { value: created.job, changed: true }
      })
    })

    const createClaimed = Effect.fn("WorkMeshLoops.createClaimed")(function* (
      input: Omit<LoopJob, "id" | "createdAt" | "nextRunAt" | "expiresAt" | "keepaliveUsed">,
    ) {
      const created = makeJob(input, true)
      const job = yield* withJobs("WorkMeshLoops.createClaimedLocked", created.now, (jobs) => {
        jobs.set(created.job.id, created.job)
        return { value: created.job, changed: true }
      })
      const data = yield* InstanceState.get(state)
      data.runningJobs.set(job.id, job.sessionID)
      data.runningSessions.add(job.sessionID)
      return job
    })

    const get = Effect.fn("WorkMeshLoops.get")(function* (id: string) {
      return yield* withJobs("WorkMeshLoops.getLocked", Date.now(), (jobs) => ({
        value: jobs.get(id),
        changed: false,
      }))
    })

    const list = Effect.fn("WorkMeshLoops.list")(function* (sessionID: SessionID) {
      return yield* withJobs("WorkMeshLoops.listLocked", Date.now(), (jobs) => ({
        value: [...jobs.values()]
          .filter((job) => job.sessionID === sessionID)
          .sort((left, right) => left.nextRunAt - right.nextRunAt),
        changed: false,
      }))
    })

    const remove = Effect.fn("WorkMeshLoops.remove")(function* (id: string) {
      return yield* withJobs("WorkMeshLoops.removeLocked", Date.now(), (jobs) => {
        const removed = jobs.delete(id)
        return { value: removed, changed: removed }
      })
    })

    const resolve = Effect.fn("WorkMeshLoops.resolve")(function* (sessionID: SessionID, idOrPrefix: string) {
      const jobs = yield* list(sessionID)
      const matches = jobs.filter((job) => job.id === idOrPrefix || job.id.startsWith(idOrPrefix))
      if (matches.length > 1) throw new Error(`循环 ID 前缀不唯一：${idOrPrefix}`)
      return matches[0]
    })

    const claim = Effect.fn("WorkMeshLoops.claim")(function* (id: string, inputNow?: number) {
      const now = inputNow ?? Date.now()
      const claimed = yield* withJobs("WorkMeshLoops.claimLocked", now, (jobs, data) => {
        const job = jobs.get(id)
        if (!job || job.nextRunAt > now || data.runningSessions.has(job.sessionID)) {
          return { value: undefined, changed: false }
        }
        job.nextRunAt = now + job.intervalSeconds * 1000
        return { value: { ...job }, changed: true }
      })
      if (!claimed) return undefined
      const data = yield* InstanceState.get(state)
      data.runningJobs.set(claimed.id, claimed.sessionID)
      data.runningSessions.add(claimed.sessionID)
      return claimed
    })

    const claimDue = Effect.fn("WorkMeshLoops.claimDue")(function* (inputNow?: number) {
      const now = inputNow ?? Date.now()
      const claimed = yield* withJobs("WorkMeshLoops.claimDueLocked", now, (jobs, data) => {
        const sessions = new Set(data.runningSessions)
        const due = [...jobs.values()]
          .filter((job) => job.nextRunAt <= now && !sessions.has(job.sessionID))
          .sort((left, right) => left.nextRunAt - right.nextRunAt)
          .filter((job) => {
            if (sessions.has(job.sessionID)) return false
            sessions.add(job.sessionID)
            return true
          })
        for (const job of due) job.nextRunAt = now + job.intervalSeconds * 1000
        return { value: due.map((job) => ({ ...job })), changed: due.length > 0 }
      })
      const data = yield* InstanceState.get(state)
      for (const job of claimed) {
        data.runningJobs.set(job.id, job.sessionID)
        data.runningSessions.add(job.sessionID)
      }
      return claimed
    })

    const completeTick = Effect.fn("WorkMeshLoops.completeTick")(function* (
      id: string,
      succeeded: boolean,
      inputNow?: number,
    ) {
      const now = inputNow ?? Date.now()
      const data = yield* InstanceState.get(state)
      const release = Effect.sync(() => {
        const sessionID = data.runningJobs.get(id)
        data.runningJobs.delete(id)
        if (sessionID) data.runningSessions.delete(sessionID)
      })
      return yield* withJobs("WorkMeshLoops.completeTickLocked", now, (jobs) => {
        const job = jobs.get(id)
        if (!job) return { value: undefined, changed: false }
        if (!succeeded && job.keepaliveUsed === 0) {
          job.keepaliveUsed = 1
          job.nextRunAt = now + KEEPALIVE_DELAY_SECONDS * 1000
        } else {
          job.keepaliveUsed = 0
          job.nextRunAt = now + job.intervalSeconds * 1000
        }
        return { value: { ...job }, changed: true }
      }).pipe(Effect.ensuring(release))
    })

    const withSessionLock = <A, E, R>(sessionID: SessionID, effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const data = yield* InstanceState.get(state)
        yield* Flock.effect(`workmesh-loop-session:${sessionID}`, {
          dir: data.lockDir,
          staleMs: 30_000,
          timeoutMs: 7 * 24 * 60 * 60 * 1000,
        })
        return yield* effect
      }).pipe(Effect.scoped)

    return Service.of({
      create,
      createClaimed,
      get,
      list,
      remove,
      resolve,
      claim,
      claimDue,
      completeTick,
      withSessionLock,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as WorkMeshLoops from "./loops"
