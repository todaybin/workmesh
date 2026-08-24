import path from "node:path"
import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { Flock } from "@opencode-ai/core/util/flock"
import { Compose } from "@opencode-ai/schema/compose"
import { Schema } from "effect"
import { ensureRuntimeLayout, type RuntimeLayout } from "@/workmesh/runtime-layout"

const SCHEMA_VERSION = "workmesh.compose.v1" as const
const SNAPSHOT = "run.json"
const JOURNAL = "journal.jsonl"
const LEASE = "lease.json"
const LOCK_STALE_MS = 30_000
const LEASE_HEARTBEAT_MS = 5_000

const decodeRun = Schema.decodeUnknownSync(Compose.Info)

export type StartInput = {
  task: string
  mode?: Compose.Mode
  taskType?: Compose.TaskType
  featureName?: string
  sessionID?: string
  language?: Compose.Language
  maxConcurrent?: number
  isolateWorktrees?: boolean
  skipBrainstorm?: boolean
  skipReport?: boolean
  baseBranch?: string
  baseSha?: string
  baseDirty?: boolean
}

export type TransitionInput = {
  id: Compose.ID
  phase: Compose.Phase
}

export type ReviseInput = {
  id: Compose.ID
  instruction: string
}

export type SaveSpecInput = {
  id: Compose.ID
  revision: number
  spec: Compose.Spec
}

export type ApproveSpecInput = SaveSpecInput & {
  strategy: Compose.WorkspaceStrategy
  baseDirty: boolean
  workingSnapshotPath?: string
  workingSnapshotSha256?: string
}

export type UpdateTaskInput = {
  id: Compose.ID
  taskID: string
  patch: Partial<Omit<Compose.Task, "id">>
}

export type FinishInput = {
  id: Compose.ID
  action: Compose.FinishAction
}

export type PersistedFinishResult = {
  message: string
  prURL?: string
  removeWorktree: boolean
  deleteBranch: boolean
  forceRemove: boolean
}

export type FinishGitResultInput = FinishInput & PersistedFinishResult

export type RunUpdater = (run: Compose.Info) => Compose.Info

export type ExecutionLease = {
  readonly runID: Compose.ID
  readonly ownerID: string
  readonly acquiredAt: number
  release(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export type LeaseOptions = {
  ownerID?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export type LeasedRun = {
  readonly run: Compose.Info
  readonly lease: ExecutionLease
}

export type FinishLease = LeasedRun & {
  readonly action: Compose.FinishAction
  readonly needsGit: boolean
  readonly needsCleanup: boolean
  readonly result?: PersistedFinishResult
}

export type ServiceOptions = {
  directory: string
  onUpdated?: (run: Compose.Info) => void | Promise<void>
}

export class ComposeRunError extends Error {
  constructor(
    readonly code: "not-found" | "already-exists" | "invalid-transition" | "invalid-input" | "corrupt-state" | "locked",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "ComposeRunError"
  }
}

export async function createComposeService(options: ServiceOptions) {
  const layout = await ensureRuntimeLayout(options.directory)

  const get = (id: Compose.ID) => loadRun(layout, id)

  const list = async () => {
    const entries = await readdir(layout.composeState, { withFileTypes: true })
    const runs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("cmp_"))
        .map((entry) =>
          loadRun(layout, entry.name as Compose.ID).catch((error) => {
            if (error instanceof ComposeRunError && error.code === "not-found") return
            throw error
          }),
        ),
    )
    return runs.filter((run): run is Compose.Info => run !== undefined).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  const start = async (input: StartInput) => {
    const task = input.task.trim()
    if (!task) throw new ComposeRunError("invalid-input", "Compose 任务不能为空")
    const maxConcurrent = input.maxConcurrent ?? 8
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 64) {
      throw new ComposeRunError("invalid-input", "Compose 最大并发数必须是 1 到 64 之间的整数")
    }

    const id = Compose.ID.create()
    const now = Date.now()
    const mode = input.mode ?? "automatic"
    const phase: Compose.Phase = mode === "interactive" ? "orient" : input.skipBrainstorm ? "design" : "brainstorm"
    const run = decodePersistableRun({
      schemaVersion: SCHEMA_VERSION,
      id,
      projectRoot: layout.projectRoot,
      sessionID: input.sessionID,
      mode,
      taskType: input.taskType ?? "feature",
      task,
      featureName: input.featureName?.trim() || undefined,
      language: input.language ?? "auto",
      phase,
      status: "running",
      revision: 0,
      verificationAttempts: 0,
      reviewFixAttempts: 0,
      journalSeq: 1,
      createdAt: now,
      updatedAt: now,
      tasks: [],
      amendments: [],
      config: {
        maxConcurrent,
        isolateWorktrees: input.isolateWorktrees ?? true,
        skipBrainstorm: input.skipBrainstorm ?? false,
        skipReport: input.skipReport ?? false,
      },
      git: {
        baseBranch: input.baseBranch,
        baseSha: input.baseSha,
        baseDirty: input.baseDirty,
        commits: [],
      },
    })

    await withStateLock(layout, id, async () => {
      const dir = runDirectory(layout, id)
      const temporary = path.join(layout.composeState, `.${id}.${process.pid}.${randomUUID()}.tmp`)
      try {
        await mkdir(temporary)
        await persist(temporary, { seq: 1, at: now, action: "started", run })
        await rename(temporary, dir)
      } catch (error) {
        await rm(temporary, { recursive: true, force: true })
        if (isCode(error, "EEXIST")) throw new ComposeRunError("already-exists", `Compose 运行已存在：${id}`)
        throw error
      }
    })
    await options.onUpdated?.(run)
    return run
  }

  const mutate = async (
    id: Compose.ID,
    action: string,
    reducer: (current: Compose.Info) => Compose.Info,
    lease?: ExecutionLease,
  ) => {
    const result = await withStateLock(layout, id, async () => {
      const current = await loadRun(layout, id)
      await assertMutationFence(layout, current, lease)
      const candidate = decodePersistableRun({
        ...reducer(clone(current)),
        id: current.id,
        projectRoot: current.projectRoot,
        schemaVersion: SCHEMA_VERSION,
        executionOwnerID: current.executionOwnerID,
        createdAt: current.createdAt,
        journalSeq: current.journalSeq,
        updatedAt: current.updatedAt,
      })
      if (JSON.stringify(candidate) === JSON.stringify(current)) return { run: current, changed: false }
      const now = Date.now()
      const next = decodePersistableRun({
        ...candidate,
        journalSeq: current.journalSeq + 1,
        updatedAt: Math.max(now, current.updatedAt + 1),
      })
      await persist(runDirectory(layout, id), { seq: next.journalSeq, at: now, action, run: next })
      return { run: next, changed: true }
    })
    if (result.changed) await options.onUpdated?.(result.run)
    return result.run
  }

  const update = (id: Compose.ID, action: string, reducer: RunUpdater, lease?: ExecutionLease) => {
    const name = action.trim()
    if (!name || name.length > 80) throw new ComposeRunError("invalid-input", "Compose 更新动作名称长度必须为 1 到 80")
    return mutate(id, `updated:${name}`, reducer, lease)
  }

  const transition = (input: TransitionInput, lease?: ExecutionLease) =>
    mutate(input.id, `transition:${input.phase}`, (run) => {
      assertTransition(run, input.phase)
      return {
        ...run,
        phase: input.phase,
        status: statusForPhase(input.phase),
        resumePhase: undefined,
        lastError: undefined,
      }
    }, lease)

  const approve = (id: Compose.ID) =>
    mutate(id, "approved", (run) => {
      if (run.phase === "workspace" && run.status === "running" && run.approvedAt !== undefined) return run
      if (run.phase !== "awaiting_approval" || run.status !== "awaiting_approval") {
        throw invalidTransition(run, "workspace")
      }
      return { ...run, phase: "workspace", status: "running", approvedAt: Date.now(), resumePhase: undefined }
    })

  const approveForExecution = async (id: Compose.ID, leaseOptions: LeaseOptions = {}): Promise<LeasedRun> => {
    // Approval is durable before the lease is attempted. A crashed or contended caller
    // therefore leaves a recoverable running checkpoint instead of losing consent.
    await approve(id)
    const lease = await acquireExecutionLease(id, leaseOptions)
    return { run: await get(id), lease }
  }

  const saveSpec = (input: SaveSpecInput) =>
    mutate(input.id, "spec-draft-written", (run) => {
      if (!["orient", "grill", "spec", "brainstorm", "design", "awaiting_approval"].includes(run.phase)) {
        throw new ComposeRunError("invalid-transition", "当前阶段不能更新 Compose 规格")
      }
      if (run.revision !== input.revision) throw new ComposeRunError("invalid-transition", "Compose 规格修订版本已变化")
      return { ...run, spec: input.spec }
    })

  const approveSpec = async (input: ApproveSpecInput, lease: ExecutionLease) => {
    return mutate(input.id, "spec-approved", (run) => {
      if (run.phase !== "awaiting_approval" || run.status !== "awaiting_approval") {
        throw new ComposeRunError("invalid-transition", "只有等待审批的 Compose 运行可以批准")
      }
      if (run.revision !== input.revision) throw new ComposeRunError("invalid-transition", "Compose 规格修订版本已变化")
      if (run.spec?.sha256 !== input.spec.sha256 || input.spec.approvedSha256 !== input.spec.sha256) {
        throw new ComposeRunError("invalid-transition", "Compose 审批规格哈希不匹配")
      }
      return {
        ...run,
        phase: "workspace",
        status: "running",
        approvedAt: Date.now(),
        resumePhase: undefined,
        spec: input.spec,
        config: {
          ...run.config,
          maxConcurrent: input.strategy === "include_working" ? 1 : run.config.maxConcurrent,
        },
        git: {
          ...run.git,
          baseDirty: input.baseDirty,
          workspaceStrategy: input.strategy,
          workingSnapshotPath: input.workingSnapshotPath,
          workingSnapshotSha256: input.workingSnapshotSha256,
        },
      }
    }, lease)
  }

  const approveSpecForExecution = async (
    input: ApproveSpecInput,
    leaseOptions: LeaseOptions = {},
  ): Promise<LeasedRun> => {
    const lease = await acquireExecutionLease(input.id, leaseOptions)
    try {
      return { run: await approveSpec(input, lease), lease }
    } catch (error) {
      await lease.release()
      throw error
    }
  }

  const revise = (input: ReviseInput) =>
    mutate(input.id, "revised", (run) => {
      const instruction = input.instruction.trim()
      if (!instruction) throw new ComposeRunError("invalid-input", "Compose 修订要求不能为空")
      if (run.phase !== "awaiting_approval" || run.status !== "awaiting_approval") {
        throw new ComposeRunError("invalid-transition", "只有等待规格审批的 Compose 运行可以修订")
      }
      const revision = run.revision + 1
      return {
        ...run,
        revision,
        amendments: [...run.amendments, { revision, instruction, createdAt: Date.now() }],
      }
    })

  const cancelLeased = (id: Compose.ID, lease: ExecutionLease) =>
    mutate(id, "cancelled", (run) => {
      if (terminal(run.status)) throw new ComposeRunError("invalid-transition", `Compose 运行 ${id} 已结束`)
      if (run.status === "cancelled") return run
      return { ...run, resumePhase: run.phase, phase: "cancelled", status: "cancelled" }
    }, lease)

  const cancel = async (id: Compose.ID, leaseOptions: LeaseOptions = {}) => {
    const lease = await acquireExecutionLease(id, leaseOptions)
    try {
      return await cancelLeased(id, lease)
    } finally {
      await lease.release()
    }
  }

  const fail = (id: Compose.ID, message: string, lease?: ExecutionLease) =>
    mutate(id, "failed", (run) => {
      if (terminal(run.status)) throw new ComposeRunError("invalid-transition", `Compose 运行 ${id} 已结束`)
      const lastError = message.trim()
      if (!lastError) throw new ComposeRunError("invalid-input", "Compose 失败原因不能为空")
      const resumePhase = run.phase === "cancelled" || run.phase === "failed" ? run.resumePhase : run.phase
      return { ...run, resumePhase, phase: "failed", status: "failed", lastError }
    }, lease)

  const resume = (id: Compose.ID, lease?: ExecutionLease) =>
    mutate(id, "resumed", (run) => {
      if (run.status === "running") return run
      if ((run.status !== "cancelled" && run.status !== "failed") || !run.resumePhase) {
        throw new ComposeRunError("invalid-transition", `Compose 运行 ${id} 当前不可恢复`)
      }
      const phase = run.resumePhase
      return { ...run, phase, status: statusForPhase(phase), resumePhase: undefined, lastError: undefined }
    }, lease)

  const setTasks = (id: Compose.ID, tasks: ReadonlyArray<Compose.Task>, lease?: ExecutionLease) =>
    mutate(id, "tasks:set", (run) => {
      requireMutable(run)
      return { ...run, tasks: validateTasks(tasks) }
    }, lease)

  const updateTask = (input: UpdateTaskInput, lease?: ExecutionLease) =>
    mutate(input.id, `task:${input.taskID}:updated`, (run) => {
      requireMutable(run)
      const index = run.tasks.findIndex((task) => task.id === input.taskID)
      if (index < 0) throw new ComposeRunError("not-found", `Compose 子任务不存在：${input.taskID}`)
      const tasks = run.tasks.map((task, current) =>
        current === index ? { ...task, ...input.patch, id: task.id } : task,
      )
      return { ...run, tasks: validateTasks(tasks) }
    }, lease)

  const awaitFinish = (id: Compose.ID, lease?: ExecutionLease) => transition({ id, phase: "awaiting_finish" }, lease)

  const complete = async (id: Compose.ID, lease: ExecutionLease) => {
    return mutate(id, "completed", (run) => {
      if (run.phase === "completed" && run.status === "completed") return run
      if (run.phase !== "awaiting_finish" || run.status !== "awaiting_finish") throw invalidTransition(run, "completed")
      const progress = run.git.finishProgress
      if (!progress || progress.stage !== "cleanup_completed" || progress.action === "discard") {
        throw new ComposeRunError("invalid-transition", "Compose 收尾清理尚未完成，不能结束运行")
      }
      return {
        ...run,
        phase: "completed",
        status: "completed",
        completedAt: Date.now(),
        git: { ...run.git, finishAction: progress.action },
      }
    }, lease)
  }

  const prepareFinish = (input: FinishInput, lease: ExecutionLease) =>
    mutate(input.id, `finish:${input.action}:prepared`, (run) => {
      if (run.phase !== "awaiting_finish" || run.status !== "awaiting_finish") {
        throw new ComposeRunError("invalid-transition", "只有等待收尾确认的 Compose 运行可以开始收尾")
      }
      const progress = run.git.finishProgress
      if (progress?.action !== undefined && progress.action !== input.action) {
        throw new ComposeRunError("invalid-transition", `Compose 运行已选择其他收尾动作：${progress.action}`)
      }
      if (progress) return run
      return {
        ...run,
        git: {
          ...run.git,
          finishProgress: { action: input.action, stage: "prepared", startedAt: Date.now() },
        },
      }
    }, lease)

  const recordFinishGitResult = async (input: FinishGitResultInput, lease: ExecutionLease) => {
    return mutate(input.id, `finish:${input.action}:git-completed`, (run) => {
      const progress = requireFinishProgress(run, input.action)
      if (progress.stage === "git_completed" || progress.stage === "cleanup_completed") return run
      const message = input.message.trim()
      if (!message) throw new ComposeRunError("invalid-input", "Compose Git 收尾结果不能为空")
      return {
        ...run,
        git: {
          ...run.git,
          finishProgress: {
            ...progress,
            stage: "git_completed",
            gitCompletedAt: Date.now(),
            message,
            prURL: input.prURL,
            removeWorktree: input.removeWorktree,
            deleteBranch: input.deleteBranch,
            forceRemove: input.forceRemove,
          },
        },
      }
    }, lease)
  }

  const recordFinishCleanup = async (input: FinishInput, lease: ExecutionLease) => {
    return mutate(input.id, `finish:${input.action}:cleanup-completed`, (run) => {
      const progress = requireFinishProgress(run, input.action)
      if (progress.stage === "cleanup_completed") return run
      if (progress.stage !== "git_completed") {
        throw new ComposeRunError("invalid-transition", "Compose Git 主动作尚未完成，不能记录清理完成")
      }
      return {
        ...run,
        git: {
          ...run.git,
          finishProgress: { ...progress, stage: "cleanup_completed", cleanupCompletedAt: Date.now() },
        },
      }
    }, lease)
  }

  const finish = async (input: FinishInput, lease: ExecutionLease) => {
    return mutate(input.id, `finished:${input.action}`, (run) => {
      if ((run.status === "completed" || run.status === "discarded") && run.git.finishAction === input.action) {
        return run
      }
      if (run.phase !== "awaiting_finish" || run.status !== "awaiting_finish") {
        throw new ComposeRunError("invalid-transition", "只有等待收尾确认的 Compose 运行可以完成收尾")
      }
      const progress = requireFinishProgress(run, input.action)
      if (progress.stage !== "cleanup_completed") {
        throw new ComposeRunError("invalid-transition", "Compose 收尾清理尚未完成，不能结束运行")
      }
      const discarded = input.action === "discard"
      return {
        ...run,
        phase: discarded ? "discarded" : "completed",
        status: discarded ? "discarded" : "completed",
        completedAt: Date.now(),
        git: { ...run.git, finishAction: input.action },
      }
    }, lease)
  }

  const acquireExecutionLease = async (id: Compose.ID, leaseOptions: LeaseOptions = {}): Promise<ExecutionLease> => {
    await get(id)
    const ownerID = leaseOptions.ownerID ?? randomUUID()
    const acquiredAt = Date.now()
    let flock: Flock.Lease
    try {
      flock = await Flock.acquire(`compose-execution:${id}`, {
        dir: layout.composeLocks,
        staleMs: LOCK_STALE_MS,
        timeoutMs: leaseOptions.timeoutMs ?? 250,
        baseDelayMs: 25,
        maxDelayMs: 50,
        signal: leaseOptions.signal,
      })
    } catch (error) {
      throw new ComposeRunError("locked", `Compose 运行正在被其他终端执行：${id}`, { cause: error })
    }

    const leaseFile = path.join(runDirectory(layout, id), LEASE)
    const writeOwner = () =>
      writeAtomic(
        leaseFile,
        JSON.stringify({ runID: id, ownerID, pid: process.pid, acquiredAt, heartbeatAt: Date.now() }, null, 2) + "\n",
      )
    const refreshOwner = () =>
      withStateLock(layout, id, async () => {
        const [run, owner] = await Promise.all([loadRun(layout, id), readJsonOptional(leaseFile)])
        if (run.executionOwnerID !== ownerID || !isRecord(owner) || owner.ownerID !== ownerID) return
        await writeOwner()
      })
    try {
      const claimed = await withStateLock(layout, id, async () => {
        const current = await loadRun(layout, id)
        await writeOwner()
        if (current.executionOwnerID === ownerID) return { run: current, changed: false }
        const now = Date.now()
        const next = decodePersistableRun({
          ...current,
          executionOwnerID: ownerID,
          journalSeq: current.journalSeq + 1,
          updatedAt: Math.max(now, current.updatedAt + 1),
        })
        await persist(runDirectory(layout, id), {
          seq: next.journalSeq,
          at: now,
          action: "execution:claimed",
          run: next,
        })
        return { run: next, changed: true }
      })
      if (claimed.changed) await options.onUpdated?.(claimed.run)
    } catch (error) {
      const owner = await readJsonOptional(leaseFile)
      if (isRecord(owner) && owner.ownerID === ownerID) await rm(leaseFile, { force: true })
      await flock.release()
      throw error
    }
    const heartbeat = setInterval(() => void refreshOwner().catch(() => undefined), LEASE_HEARTBEAT_MS)
    heartbeat.unref?.()
    let released = false
    const release = async () => {
      if (released) return
      released = true
      clearInterval(heartbeat)
      const owner = await readJsonOptional(leaseFile)
      if (isRecord(owner) && owner.ownerID === ownerID) await rm(leaseFile, { force: true })
      await flock.release()
    }
    return { runID: id, ownerID, acquiredAt, release, [Symbol.asyncDispose]: release }
  }

  const assertExecutionLease = (id: Compose.ID, lease: ExecutionLease) =>
    withStateLock(layout, id, async () => {
      const run = await loadRun(layout, id)
      await assertMutationFence(layout, run, lease)
      return run
    })

  const recoverExecution = async (id: Compose.ID, leaseOptions: LeaseOptions = {}): Promise<LeasedRun> => {
    const lease = await acquireExecutionLease(id, leaseOptions)
    try {
      const current = await get(id)
      if (current.status === "running") return { run: current, lease }
      if (current.status === "cancelled" || current.status === "failed") {
        return { run: await resume(id, lease), lease }
      }
      throw new ComposeRunError("invalid-transition", `Compose 运行 ${id} 当前不处于可执行状态`)
    } catch (error) {
      await lease.release()
      throw error
    }
  }

  const acquireFinishLease = async (input: FinishInput, leaseOptions: LeaseOptions = {}): Promise<FinishLease> => {
    const lease = await acquireExecutionLease(input.id, leaseOptions)
    try {
      const run = await prepareFinish(input, lease)
      const progress = requireFinishProgress(run, input.action)
      return {
        run,
        action: input.action,
        lease,
        needsGit: progress.stage === "prepared",
        needsCleanup: progress.stage !== "cleanup_completed",
        result: finishResult(progress),
      }
    } catch (error) {
      await lease.release()
      throw error
    }
  }

  return {
    layout,
    list,
    get,
    start,
    update,
    transition,
    approve,
    approveForExecution,
    approveSpec,
    approveSpecForExecution,
    saveSpec,
    revise,
    cancel,
    fail,
    resume,
    setTasks,
    updateTask,
    awaitFinish,
    complete,
    recordFinishGitResult,
    recordFinishCleanup,
    finish,
    acquireExecutionLease,
    assertExecutionLease,
    recoverExecution,
    acquireFinishLease,
  }
}

type JournalEntry = {
  seq: number
  at: number
  action: string
  run: Compose.Info
}

async function loadRun(layout: RuntimeLayout, id: Compose.ID) {
  requireRunID(id)
  const dir = runDirectory(layout, id)
  const [snapshot, journal] = await Promise.all([
    readJsonOptional(path.join(dir, SNAPSHOT)).then(decodeOptionalRun),
    readJournal(path.join(dir, JOURNAL), id),
  ])
  const recovered = journal.at(-1)?.run
  const run = !snapshot
    ? recovered
    : !recovered
      ? snapshot
      : snapshot.journalSeq >= recovered.journalSeq
        ? snapshot
        : recovered
  if (!run) {
    const exists = await stat(dir).then(
      (info) => info.isDirectory(),
      (error) => {
        if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR")) return false
        throw error
      },
    )
    if (!exists) throw new ComposeRunError("not-found", `Compose 运行不存在：${id}`)
    throw new ComposeRunError("corrupt-state", `Compose 运行状态损坏且无法从 Journal 恢复：${id}`)
  }
  if (path.resolve(run.projectRoot) !== path.resolve(layout.projectRoot) || run.id !== id) {
    throw new ComposeRunError("corrupt-state", `Compose 运行不属于当前项目：${id}`)
  }
  return run
}

async function persist(dir: string, entry: JournalEntry) {
  await mkdir(dir, { recursive: true })
  const journal = path.join(dir, JOURNAL)
  await repairJournalTail(journal)
  const handle = await open(journal, "a", 0o600)
  try {
    await handle.writeFile(JSON.stringify(entry) + "\n", "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  await writeAtomic(path.join(dir, SNAPSHOT), JSON.stringify(entry.run, null, 2) + "\n")
}

async function repairJournalTail(file: string) {
  const raw = await readFile(file, "utf8").catch((error) => {
    if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR")) return ""
    throw error
  })
  if (!raw || raw.endsWith("\n")) return
  const boundary = raw.lastIndexOf("\n") + 1
  const tail = raw.slice(boundary)
  try {
    JSON.parse(tail)
    await writeAtomic(file, raw + "\n")
  } catch {
    await writeAtomic(file, raw.slice(0, boundary))
  }
}

async function readJournal(file: string, id: Compose.ID): Promise<JournalEntry[]> {
  const raw = await readFile(file, "utf8").catch((error) => {
    if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR")) return ""
    throw error
  })
  const lines = raw.split("\n").filter((line) => line.trim())
  const result: JournalEntry[] = []
  for (const [index, line] of lines.entries()) {
    try {
      const value = JSON.parse(line)
      if (!isRecord(value) || !Number.isInteger(value.seq) || typeof value.action !== "string") throw new Error()
      const run = decodeRun(value.run)
      if (run.id !== id || run.journalSeq !== value.seq) throw new Error()
      if (result.length && result.at(-1)!.seq >= value.seq) throw new Error()
      result.push({ seq: value.seq as number, at: Number(value.at), action: value.action, run })
    } catch (error) {
      if (index === lines.length - 1) break
      throw new ComposeRunError("corrupt-state", `Compose Journal 第 ${index + 1} 条记录无效：${id}`, { cause: error })
    }
  }
  return result
}

async function withStateLock<T>(layout: RuntimeLayout, id: Compose.ID, operation: () => Promise<T>) {
  requireRunID(id)
  return Flock.withLock(`compose-state:${id}`, operation, {
    dir: layout.composeLocks,
    staleMs: LOCK_STALE_MS,
    timeoutMs: 30_000,
    baseDelayMs: 20,
    maxDelayMs: 250,
  })
}

async function assertMutationFence(layout: RuntimeLayout, run: Compose.Info, lease?: ExecutionLease) {
  if (lease?.runID !== undefined && lease.runID !== run.id) {
    throw new ComposeRunError("invalid-input", "执行租约与 Compose 运行不匹配")
  }
  const owner = await readJsonOptional(path.join(runDirectory(layout, run.id), LEASE))
  if (lease) {
    if (
      !isRecord(owner) ||
      owner.ownerID !== lease.ownerID ||
      run.executionOwnerID === undefined ||
      run.executionOwnerID !== lease.ownerID
    ) {
      throw new ComposeRunError("locked", `Compose 运行的执行租约已失效：${run.id}`)
    }
    return
  }
  if (!run.executionOwnerID) return
  if (!requiresExecutionFence(run)) return
  throw new ComposeRunError("locked", `Compose 运行需要当前执行租约：${run.id}`)
}

function requiresExecutionFence(run: Compose.Info) {
  const phase = run.phase === "cancelled" || run.phase === "failed" ? run.resumePhase : run.phase
  return (
    phase !== undefined &&
    [
      "workspace",
      "implement",
      "verify",
      "review",
      "finalize",
      "report",
      "awaiting_finish",
      "completed",
      "discarded",
    ].includes(phase)
  )
}

function assertTransition(run: Compose.Info, next: Compose.Phase) {
  if (run.phase === next) return
  if (terminal(run.status) || run.status === "cancelled" || run.status === "failed") throw invalidTransition(run, next)
  const allowed = transitions[run.phase] ?? []
  if (!allowed.includes(next)) throw invalidTransition(run, next)
}

const transitions: Partial<Record<Compose.Phase, ReadonlyArray<Compose.Phase>>> = {
  orient: ["grill", "spec"],
  grill: ["grill", "spec"],
  spec: ["awaiting_approval"],
  brainstorm: ["design"],
  design: ["awaiting_approval"],
  awaiting_approval: ["workspace"],
  workspace: ["implement"],
  implement: ["verify"],
  verify: ["implement", "review"],
  review: ["implement", "finalize", "report"],
  finalize: ["awaiting_finish"],
  report: ["awaiting_finish"],
  awaiting_finish: ["completed", "discarded"],
}

function invalidTransition(run: Compose.Info, next: Compose.Phase) {
  return new ComposeRunError("invalid-transition", `Compose 运行不能从 ${run.phase} 转换到 ${next}`)
}

function statusForPhase(phase: Compose.Phase): Compose.Status {
  if (phase === "awaiting_approval") return "awaiting_approval"
  if (phase === "awaiting_finish") return "awaiting_finish"
  if (phase === "cancelled" || phase === "failed" || phase === "completed" || phase === "discarded") return phase
  return "running"
}

function terminal(status: Compose.Status) {
  return status === "completed" || status === "discarded"
}

function requireFinishProgress(run: Compose.Info, action: Compose.FinishAction) {
  const progress = run.git.finishProgress
  if (!progress) throw new ComposeRunError("invalid-transition", "Compose 收尾尚未开始")
  if (progress.action !== action) {
    throw new ComposeRunError("invalid-transition", `Compose 运行已选择其他收尾动作：${progress.action}`)
  }
  return progress
}

function finishResult(progress: Compose.FinishProgress): PersistedFinishResult | undefined {
  if (progress.stage === "prepared") return
  if (
    progress.message === undefined ||
    progress.removeWorktree === undefined ||
    progress.deleteBranch === undefined ||
    progress.forceRemove === undefined
  ) {
    throw new ComposeRunError("corrupt-state", "Compose Git 收尾结果不完整")
  }
  return {
    message: progress.message,
    prURL: progress.prURL,
    removeWorktree: progress.removeWorktree,
    deleteBranch: progress.deleteBranch,
    forceRemove: progress.forceRemove,
  }
}

function requireMutable(run: Compose.Info) {
  if (terminal(run.status)) throw new ComposeRunError("invalid-transition", `Compose 运行 ${run.id} 已结束`)
}

function validateTasks(input: ReadonlyArray<Compose.Task>): Compose.Task[] {
  const tasks = input.map((task) => {
    try {
      return decodeTask(JSON.parse(JSON.stringify(task)))
    } catch (error) {
      throw new ComposeRunError("invalid-input", `Compose 子任务格式无效：${task.id}`, { cause: error })
    }
  })
  const ids = new Set<string>()
  for (const task of tasks) {
    if (!task.id.trim()) throw new ComposeRunError("invalid-input", "Compose 子任务 ID 不能为空")
    if (ids.has(task.id)) throw new ComposeRunError("invalid-input", `Compose 子任务 ID 重复：${task.id}`)
    if (!task.description.trim()) throw new ComposeRunError("invalid-input", `Compose 子任务描述不能为空：${task.id}`)
    if (!task.acceptance.length || task.acceptance.some((item) => !item.trim())) {
      throw new ComposeRunError("invalid-input", `Compose 子任务验收条件不能为空：${task.id}`)
    }
    if (!task.covers.length || task.covers.some((item) => !item.trim())) {
      throw new ComposeRunError("invalid-input", `Compose 子任务 covers 不能为空：${task.id}`)
    }
    if (!task.files.length) throw new ComposeRunError("invalid-input", `Compose 子任务 files 不能为空：${task.id}`)
    for (const file of task.files) {
      const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "")
      if (
        !normalized ||
        path.isAbsolute(normalized) ||
        normalized.split("/").includes("..") ||
        normalized === ".git" ||
        normalized.startsWith(".git/") ||
        normalized === ".workmesh" ||
        normalized.startsWith(".workmesh/")
      ) {
        throw new ComposeRunError("invalid-input", `Compose 子任务文件范围无效：${task.id} -> ${file}`)
      }
    }
    ids.add(task.id)
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) throw new ComposeRunError("invalid-input", `Compose 子任务依赖不存在：${dependency}`)
      if (dependency === task.id) throw new ComposeRunError("invalid-input", `Compose 子任务不能依赖自身：${task.id}`)
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const byID = new Map(tasks.map((task) => [task.id, task]))
  const visit = (id: string) => {
    if (visiting.has(id)) throw new ComposeRunError("invalid-input", `Compose 子任务存在循环依赖：${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byID.get(id)!.dependsOn) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const task of tasks) visit(task.id)
  return tasks
}

const decodeTask = Schema.decodeUnknownSync(Compose.Task)

function runDirectory(layout: RuntimeLayout, id: Compose.ID) {
  requireRunID(id)
  return path.join(layout.composeState, id)
}

function requireRunID(id: string): asserts id is Compose.ID {
  if (!/^cmp_[a-zA-Z0-9]+$/.test(id)) throw new ComposeRunError("invalid-input", `Compose 运行 ID 无效：${id}`)
}

async function writeAtomic(file: string, contents: string) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 })
  try {
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function readJsonOptional(file: string): Promise<unknown> {
  return readFile(file, "utf8")
    .then((raw) => JSON.parse(raw))
    .catch((error) => {
      if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR") || error instanceof SyntaxError) return undefined
      throw error
    })
}

function decodeOptionalRun(value: unknown) {
  if (value === undefined) return
  try {
    return decodeRun(value)
  } catch {
    return
  }
}

function decodePersistableRun(value: unknown) {
  return decodeRun(JSON.parse(JSON.stringify(value)))
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isCode(error: unknown, expected: string) {
  return typeof error === "object" && error !== null && "code" in error && error.code === expected
}
