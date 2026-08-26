import path from "node:path"
import { lstat, readdir, realpath } from "node:fs/promises"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createSimpleContext } from "../context/helper"
import { useEvent } from "../context/event"
import { useProject } from "../context/project"
import { TuiProduct } from "../product"

export type ComposeRunStatus =
  | "running"
  | "awaiting_approval"
  | "awaiting_finish"
  | "cancelled"
  | "failed"
  | "completed"
  | "discarded"

export type ComposeRunView = {
  id: string
  sessionID?: string
  status: ComposeRunStatus
  stage: string
  completedTasks: number
  totalTasks: number
  updatedAt?: number
  baseDirty?: boolean
  baseSha?: string
  headSha?: string
  branch?: string
  worktree?: string
  specPath?: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function samePath(left: string, right: string) {
  const a = path.normalize(path.resolve(left))
  const b = path.normalize(path.resolve(right))
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

export function composeStateDirectory(projectRoot: string) {
  return path.resolve(projectRoot, ".workmesh", "state", "compose")
}

export async function loadComposeRuns(projectRoot: string) {
  const root = await realpath(path.resolve(projectRoot)).catch(() => undefined)
  if (!root) return []
  const expected = composeStateDirectory(root)
  const state = await realpath(expected).catch(() => undefined)
  if (!state) return []
  const relative = path.relative(root, state)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return []

  const entries = await readdir(state, { withFileTypes: true }).catch(() => [])
  const runs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^cmp_[a-zA-Z0-9]+$/.test(entry.name))
      .map(async (entry) => {
        const directory = path.join(state, entry.name)
        const directoryInfo = await lstat(directory).catch(() => undefined)
        if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) return
        const file = path.join(directory, "run.json")
        const info = await lstat(file).catch(() => undefined)
        if (!info?.isFile() || info.isSymbolicLink()) return
        const raw = await Bun.file(file)
          .json()
          .catch(() => undefined)
        const run = record(raw)
        if (!run || text(run.id) !== entry.name) return
        const owner = text(run.projectRoot)
        if (!owner || !samePath(owner, root)) return
        return parseComposeRunEvent({ type: "compose.run.updated", properties: { run } })
      }),
  )
  return runs.filter((run): run is ComposeRunView => run !== undefined)
}

export function mergeComposeRuns(current: Record<string, ComposeRunView>, incoming: readonly ComposeRunView[]) {
  return incoming.reduce<Record<string, ComposeRunView>>(
    (result, run) => {
      const existing = result[run.id]
      if (!existing || (existing.updatedAt ?? 0) < (run.updatedAt ?? 0)) result[run.id] = run
      return result
    },
    { ...current },
  )
}

export function formatComposeDialogKey(run: ComposeRunView, revision = 0) {
  return `${run.id}:${run.status}:${run.updatedAt ?? 0}:${revision}`
}

export type ComposeCommandAction =
  | "approve"
  | "approve_head"
  | "approve_working"
  | "revise"
  | "cancel"
  | "merge"
  | "pr"
  | "push"
  | "keep"
  | "discard"

export function composeCommandArguments(runID: string, action: ComposeCommandAction, detail?: string) {
  const confirmed = ["merge", "pr", "push", "keep", "discard"].includes(action)
  return [action, runID, detail, confirmed ? "--confirmed" : undefined].filter(Boolean).join(" ")
}

export function parseComposeRunEvent(event: unknown): ComposeRunView | undefined {
  const root = record(event)
  if (root?.type !== "compose.run.updated") return
  const properties = record(root.properties)
  const run = record(properties?.run) ?? record(properties?.info) ?? properties
  const id = text(run?.id) ?? text(run?.runID) ?? text(run?.runId)
  const status = text(run?.status)
  const stage = text(run?.phase) ?? text(run?.stage)
  if (!id || !status || !stage) return
  if (
    !["running", "awaiting_approval", "awaiting_finish", "cancelled", "failed", "completed", "discarded"].includes(
      status,
    )
  )
    return

  const tasks = Array.isArray(run?.tasks) ? run.tasks : []
  const completedTasks =
    count(run?.completedTasks) ?? tasks.filter((item) => record(item)?.status === "completed").length
  const totalTasks = count(run?.totalTasks) ?? tasks.length
  const git = record(run?.git)
  const spec = record(run?.spec)
  const projectRoot = text(run?.projectRoot)
  const worktree = text(git?.worktree)
  const approvedPath = text(spec?.approvedPath)
  return {
    id,
    sessionID: text(run?.sessionID) ?? text(run?.sessionId),
    status: status as ComposeRunStatus,
    stage,
    completedTasks,
    totalTasks,
    updatedAt: count(run?.updatedAt),
    baseDirty: typeof git?.baseDirty === "boolean" ? git.baseDirty : undefined,
    baseSha: text(git?.baseSha),
    headSha: text(git?.headSha),
    branch: text(git?.branch),
    worktree,
    specPath:
      approvedPath && projectRoot && worktree
        ? path.join(worktree, path.relative(projectRoot, approvedPath))
        : (approvedPath ?? text(spec?.draftPath)),
  }
}

export const { use: useComposeRuns, provider: ComposeRunsProvider } = createSimpleContext({
  name: "ComposeRuns",
  init: () => {
    const event = useEvent()
    const project = useProject()
    const [runs, setRuns] = createSignal<Record<string, ComposeRunView>>({})
    const [dialogRequests, setDialogRequests] = createSignal<Record<string, number>>({})
    let hydration = 0

    createEffect(() => {
      if (!TuiProduct.enabled) return
      const instance = project.instance.path()
      const root = instance.worktree && instance.worktree !== "/" ? instance.worktree : instance.directory
      const current = ++hydration
      setRuns({})
      setDialogRequests({})
      if (!root) return
      void loadComposeRuns(root).then((loaded) => {
        if (current !== hydration) return
        setRuns((existing) => mergeComposeRuns(existing, loaded))
      })
    })

    const unsubscribe = event.subscribe((payload, metadata) => {
      if (!TuiProduct.enabled) return
      if (metadata.workspace !== project.workspace.current()) return
      const run = parseComposeRunEvent(payload)
      if (!run) return
      setRuns((current) => ({ ...current, [run.id]: run }))
    })
    onCleanup(() => {
      hydration++
      unsubscribe()
    })

    return {
      runs,
      get(id: string) {
        return runs()[id]
      },
      requestDialog(id: string) {
        setDialogRequests((current) => ({ ...current, [id]: (current[id] ?? 0) + 1 }))
      },
      dialogRevision(id: string) {
        return dialogRequests()[id] ?? 0
      },
      active: (sessionID?: string) =>
        createMemo(() => {
          const matches = Object.values(runs()).filter((run) => !sessionID || run.sessionID === sessionID)
          return matches.toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
        }),
    }
  },
})

export const composeStageNames: Record<string, { en: string; "zh-CN": string }> = {
  orient: { en: "Orient", "zh-CN": "定位" },
  grill: { en: "Grill", "zh-CN": "澄清" },
  spec: { en: "Spec", "zh-CN": "规格" },
  brainstorm: { en: "Brainstorm", "zh-CN": "构思" },
  design: { en: "Design", "zh-CN": "设计" },
  awaiting_approval: { en: "Awaiting approval", "zh-CN": "等待批准" },
  workspace: { en: "Workspace", "zh-CN": "工作区" },
  implement: { en: "Implement", "zh-CN": "实现" },
  verify: { en: "Verify", "zh-CN": "验证" },
  review: { en: "Review", "zh-CN": "审查" },
  report: { en: "Report", "zh-CN": "报告" },
  finalize: { en: "Finalize", "zh-CN": "收尾" },
  awaiting_finish: { en: "Awaiting finish", "zh-CN": "等待收尾确认" },
  completed: { en: "Completed", "zh-CN": "已完成" },
  cancelled: { en: "Cancelled", "zh-CN": "已取消" },
  failed: { en: "Failed", "zh-CN": "失败" },
}
