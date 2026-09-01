import path from "node:path"
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { Flock } from "@opencode-ai/core/util/flock"
import type { Compose } from "@opencode-ai/schema/compose"
import { Process } from "@/util/process"
import { ensureRuntimeLayout } from "@/workmesh/runtime-layout"
import { applyComposeWorkingSnapshot } from "./working-snapshot"

export type ComposeWorkspace = {
  branch: string
  directory: string
}

export class ComposeWorkspaceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ComposeWorkspaceError"
  }
}

function checkedLocation(projectRoot: string, directory: string) {
  const root = path.resolve(projectRoot, ".workmesh", "worktrees")
  const target = path.resolve(directory)
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ComposeWorkspaceError("Compose Worktree 必须位于项目的 .workmesh/worktrees 目录内")
  }
  return { root, target }
}

function samePath(left: string, right: string) {
  const a = path.normalize(path.resolve(left))
  const b = path.normalize(path.resolve(right))
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

async function git(cwd: string, args: string[], allowFailure = false) {
  const result = await Process.text(["git", ...args], { cwd, nothrow: true })
  if (result.code !== 0 && !allowFailure) {
    throw new ComposeWorkspaceError(
      result.stderr.toString("utf8").trim() || result.text.trim() || `Git 命令执行失败：git ${args.join(" ")}`,
    )
  }
  return result
}

export async function createComposeWorkspace(run: Compose.Info): Promise<ComposeWorkspace> {
  const layout = await ensureRuntimeLayout(run.projectRoot)
  return Flock.withLock(`compose-workspace:${run.id}`, () => createLocked(run), {
    dir: layout.composeLocks,
    staleMs: 30_000,
    timeoutMs: 30_000,
    baseDelayMs: 20,
    maxDelayMs: 250,
  })
}

async function createLocked(run: Compose.Info): Promise<ComposeWorkspace> {
  const branch = `workmesh/compose/${run.id}`
  const location = checkedLocation(run.projectRoot, path.join(run.projectRoot, ".workmesh", "worktrees", run.id))
  await mkdir(location.root, { recursive: true })

  const branchRef = `refs/heads/${branch}`
  const registered = parseWorktrees((await git(run.projectRoot, ["worktree", "list", "--porcelain"])).text)
  const atTarget = registered.find((item) => samePath(item.directory, location.target))
  const forBranch = registered.find((item) => item.branch === branchRef)
  if (atTarget) {
    if (atTarget.branch !== branchRef) {
      throw new ComposeWorkspaceError(`Compose Worktree 已被其他分支占用：${atTarget.branch ?? "detached HEAD"}`)
    }
    if (await exists(location.target)) {
      const current = (await git(location.target, ["branch", "--show-current"])).text.trim()
      if (current !== branch)
        throw new ComposeWorkspaceError(`Compose Worktree 分支不匹配：${current || "detached HEAD"}`)
      if (run.git.workspaceStrategy === "include_working") await applyComposeWorkingSnapshot(run, location.target)
      await copyApprovedSpec(run, location.target)
      return { branch, directory: location.target }
    }
    await git(run.projectRoot, ["worktree", "remove", "--force", location.target])
  } else if (forBranch) {
    throw new ComposeWorkspaceError(`Compose 分支已关联到其他 Worktree：${forBranch.directory}`)
  }

  if ((await exists(location.target)) && (await readdir(location.target)).length > 0) {
    throw new ComposeWorkspaceError("Compose Worktree 目标目录已存在且不为空，拒绝覆盖")
  }

  const existing = await git(run.projectRoot, ["show-ref", "--verify", "--quiet", branchRef], true)
  const base = run.git.baseSha ?? "HEAD"
  await git(
    run.projectRoot,
    existing.code === 0
      ? ["worktree", "add", location.target, branch]
      : ["worktree", "add", "-b", branch, location.target, base],
  )
  if (run.git.workspaceStrategy === "include_working") {
    await applyComposeWorkingSnapshot(run, location.target)
  }
  await copyApprovedSpec(run, location.target)
  return { branch, directory: location.target }
}

async function copyApprovedSpec(run: Compose.Info, target: string) {
  const source = run.spec?.approvedPath
  if (!source) return
  const relative = path.relative(run.projectRoot, path.resolve(source))
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ComposeWorkspaceError("Compose 正式规格不在当前项目内")
  }
  const destination = path.join(target, relative)
  const info = await lstat(source).catch(() => undefined)
  if (!info) {
    const copied = await lstat(destination).catch(() => undefined)
    if (copied?.isFile() && !copied.isSymbolicLink()) return
    throw new ComposeWorkspaceError("Compose 正式规格文件缺失")
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new ComposeWorkspaceError("Compose 正式规格不是普通文件")
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, await readFile(source))
  if (run.spec?.temporaryProjectCopy) await rm(source, { force: true })
}

function parseWorktrees(output: string) {
  return output
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const fields = new Map(
        block
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => {
            const separator = line.indexOf(" ")
            return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)]
          }),
      )
      const directory = fields.get("worktree")
      if (!directory) return
      return { directory, branch: fields.get("branch") }
    })
    .filter((item): item is { directory: string; branch: string | undefined } => item !== undefined)
}

async function exists(target: string) {
  return stat(target).then(
    () => true,
    (error) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false
      throw error
    },
  )
}

export async function removeComposeWorkspace(run: Compose.Info, options: { deleteBranch: boolean; force: boolean }) {
  if (!run.git.worktree) throw new ComposeWorkspaceError("Compose 运行没有可删除的 Worktree")
  if (!run.git.branch?.startsWith("workmesh/compose/")) {
    throw new ComposeWorkspaceError("拒绝删除非 WorkMesh Compose 分支")
  }
  const location = checkedLocation(run.projectRoot, run.git.worktree)
  const removed = await git(
    run.projectRoot,
    ["worktree", "remove", ...(options.force ? ["--force"] : []), location.target],
    true,
  )
  if (removed.code !== 0) {
    const listed = await git(run.projectRoot, ["worktree", "list", "--porcelain"])
    if (
      listed.text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("worktree "))
        .some((line) => samePath(line.slice("worktree ".length), location.target))
    ) {
      throw new ComposeWorkspaceError(
        removed.stderr.toString("utf8").trim() || removed.text.trim() || "删除 Compose Worktree 失败",
      )
    }
  }
  await rm(location.target, { recursive: true, force: true })
  if (!options.deleteBranch) return
  const deleted = await git(run.projectRoot, ["branch", "-D", run.git.branch], true)
  if (deleted.code === 0) return
  const branchRef = await git(
    run.projectRoot,
    ["show-ref", "--verify", "--quiet", `refs/heads/${run.git.branch}`],
    true,
  )
  if (branchRef.code !== 0) return
  throw new ComposeWorkspaceError(
    deleted.stderr.toString("utf8").trim() || deleted.text.trim() || "删除 Compose 分支失败",
  )
}
