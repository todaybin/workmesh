import path from "node:path"
import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { Flock } from "@opencode-ai/core/util/flock"
import { Process } from "@/util/process"
import { Wildcard } from "@/util/wildcard"
import type { Compose } from "@opencode-ai/schema/compose"

export type TaskWorkspace = {
  taskID: string
  directory: string
  branch: string
  files: readonly string[]
}

export class ComposeTaskWorkspaceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ComposeTaskWorkspaceError"
  }
}

export async function createComposeTaskWorkspace(run: Compose.Info, task: Compose.Task): Promise<TaskWorkspace> {
  const integration = run.git.worktree
  const integrationBranch = run.git.branch
  if (!integration || !integrationBranch) throw new ComposeTaskWorkspaceError("Compose 运行缺少集成 Worktree")
  const suffix = `${
    task.id
      .replace(/[^a-zA-Z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "task"
  }-${createHash("sha256").update(task.id).digest("hex").slice(0, 8)}`
  const directory = path.join(run.projectRoot, ".workmesh", "worktrees", "tasks", run.id, suffix)
  const branch = `workmesh/compose/${run.id}-${suffix}`
  return Flock.withLock(
    `compose-task-workspace:${run.id}:${task.id}`,
    async () => {
      await mkdir(path.dirname(directory), { recursive: true })
      const available = await lstat(directory).then(
        (info) => info.isDirectory(),
        () => false,
      )
      const current = available
        ? await gitText(directory, ["branch", "--show-current"], true)
        : { code: -1, text: "", stderr: Buffer.from("") }
      if (current.code === 0 && current.text.trim() === branch) {
        await overlayComposeWorkspace(integration, directory)
        return { taskID: task.id, directory, branch, files: task.files }
      }
      const entries = await readdir(directory).catch(() => [])
      if (entries.length) throw new ComposeTaskWorkspaceError(`Compose 任务 Worktree 目录非空：${directory}`)
      const exists = await gitText(run.projectRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], true)
      await gitText(
        run.projectRoot,
        exists.code === 0
          ? ["worktree", "add", directory, branch]
          : ["worktree", "add", "-b", branch, directory, integrationBranch],
      )
      await overlayComposeWorkspace(integration, directory)
      return { taskID: task.id, directory, branch, files: task.files }
    },
    {
      dir: path.join(run.projectRoot, ".workmesh", "state", "locks", "compose"),
      staleMs: 30_000,
      timeoutMs: 30_000,
      baseDelayMs: 20,
      maxDelayMs: 250,
    },
  )
}

export async function applyComposeTaskChanges(integration: string, workspaces: readonly TaskWorkspace[]) {
  const changes = await Promise.all(
    workspaces.map(async (workspace) => ({ workspace, paths: await changedAgainst(workspace.directory, integration) })),
  )
  const owners = new Map<string, string>()
  for (const item of changes) {
    for (const file of item.paths) {
      if (!item.workspace.files.some((pattern) => covers(pattern, file))) {
        throw new ComposeTaskWorkspaceError(`任务 ${item.workspace.taskID} 写入了未声明文件：${file}`)
      }
      const owner = owners.get(file)
      if (owner)
        throw new ComposeTaskWorkspaceError(`Compose 并行任务写入冲突：${owner} 与 ${item.workspace.taskID} -> ${file}`)
      owners.set(file, item.workspace.taskID)
    }
  }
  for (const item of changes) {
    for (const file of item.paths) await mirror(item.workspace.directory, integration, file)
  }
  return changes.map((item) => ({ taskID: item.workspace.taskID, paths: item.paths }))
}

export async function removeComposeTaskWorkspaces(run: Compose.Info) {
  const root = path.resolve(run.projectRoot, ".workmesh", "worktrees", "tasks", run.id)
  const prefix = `workmesh/compose/${run.id}-`
  const registered = parseWorktrees((await gitText(run.projectRoot, ["worktree", "list", "--porcelain"])).text)
  const worktrees = registered.filter((item) => isWithin(root, item.directory))
  for (const item of worktrees) {
    const removed = await gitText(run.projectRoot, ["worktree", "remove", "--force", item.directory], true)
    if (
      removed.code !== 0 &&
      parseWorktrees((await gitText(run.projectRoot, ["worktree", "list", "--porcelain"])).text).some((current) =>
        samePath(current.directory, item.directory),
      )
    ) {
      throw new ComposeTaskWorkspaceError(
        removed.stderr.toString("utf8").trim() ||
          removed.text.trim() ||
          `删除 Compose 任务 Worktree 失败：${item.directory}`,
      )
    }
    await rm(item.directory, { recursive: true, force: true })
  }
  await rm(root, { recursive: true, force: true })
  const branches = (
    await gitText(run.projectRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads/workmesh/compose"])
  ).text
    .split(/\r?\n/)
    .filter((branch) => branch.startsWith(prefix))
  for (const branch of branches) {
    const deleted = await gitText(run.projectRoot, ["branch", "-D", branch], true)
    if (deleted.code === 0) continue
    const exists = await gitText(run.projectRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], true)
    if (exists.code !== 0) continue
    throw new ComposeTaskWorkspaceError(
      deleted.stderr.toString("utf8").trim() || deleted.text.trim() || `删除 Compose 任务分支失败：${branch}`,
    )
  }
}

function covers(pattern: string, file: string) {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "")
  if (!normalized) return false
  if (normalized.endsWith("/")) return file.startsWith(normalized)
  return Wildcard.match(file, normalized) || (!normalized.includes("*") && file.startsWith(`${normalized}/`))
}

export async function overlayComposeWorkspace(source: string, target: string) {
  for (const file of await statusPaths(source)) await mirror(source, target, file)
}

async function changedAgainst(source: string, baseline: string) {
  const candidates = new Set([...(await statusPaths(source)), ...(await statusPaths(baseline))])
  const changed: string[] = []
  for (const file of candidates) {
    const left = await content(path.join(source, file))
    const right = await content(path.join(baseline, file))
    if (left === undefined && right === undefined) continue
    if (!left || !right || !left.equals(right)) changed.push(file)
  }
  return changed.toSorted()
}

async function statusPaths(directory: string) {
  const result = await gitText(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"])
  return result.text
    .split("\0")
    .filter(Boolean)
    .map((entry) => safeRelative(entry.slice(3)))
    .filter((file) => file !== ".workmesh" && !file.startsWith(".workmesh/"))
}

function safeRelative(file: string) {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "")
  if (!normalized || path.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new ComposeTaskWorkspaceError(`Compose 任务文件路径越界：${file}`)
  }
  return normalized
}

async function content(file: string) {
  const info = await lstat(file).catch(() => undefined)
  if (!info) return
  if (info.isSymbolicLink() || !info.isFile())
    throw new ComposeTaskWorkspaceError(`Compose 任务只允许交付普通文件：${file}`)
  return readFile(file)
}

async function mirror(source: string, target: string, file: string) {
  const from = path.join(source, safeRelative(file))
  const to = path.join(target, safeRelative(file))
  const data = await content(from)
  if (!data) {
    await rm(to, { force: true })
    return
  }
  await mkdir(path.dirname(to), { recursive: true })
  await writeFile(to, data)
}

async function gitText(directory: string, args: string[], allowFailure = false) {
  const result = await Process.text(["git", ...args], { cwd: directory, nothrow: true })
  if (result.code !== 0 && !allowFailure) {
    throw new ComposeTaskWorkspaceError(result.stderr.toString("utf8").trim() || result.text.trim(), {
      cause: result,
    })
  }
  return result
}

function parseWorktrees(output: string) {
  return output
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const directory = block
        .split(/\r?\n/)
        .find((line) => line.startsWith("worktree "))
        ?.slice("worktree ".length)
      const branch = block
        .split(/\r?\n/)
        .find((line) => line.startsWith("branch refs/heads/"))
        ?.slice("branch refs/heads/".length)
      return directory ? { directory, branch } : undefined
    })
    .filter((item): item is { directory: string; branch: string | undefined } => item !== undefined)
}

function isWithin(root: string, target: string) {
  const relative = path.relative(root, path.resolve(target))
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative)
}

function samePath(left: string, right: string) {
  const a = path.normalize(path.resolve(left))
  const b = path.normalize(path.resolve(right))
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}
