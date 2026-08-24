import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { Flock } from "@opencode-ai/core/util/flock"
import type { Compose } from "@opencode-ai/schema/compose"
import { Process } from "@/util/process"

type Entry = { path: string; deleted: boolean; sha256?: string; mode?: number }
type Manifest = { entries: Entry[] }

export class ComposeWorkingSnapshotError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ComposeWorkingSnapshotError"
  }
}

export async function captureComposeWorkingSnapshot(run: Compose.Info) {
  const directory = path.join(run.projectRoot, ".workmesh", "state", "compose", run.id, "working-snapshot")
  const temporary = `${directory}.${process.pid}.${randomUUID()}.tmp`
  return Flock.withLock(
    `compose-working-snapshot:${run.id}`,
    async () => {
      await rm(temporary, { recursive: true, force: true })
      await mkdir(path.join(temporary, "files"), { recursive: true })
      const entries = await Promise.all(
        (await statusPaths(run.projectRoot)).map(async (file): Promise<Entry> => {
          const source = path.join(run.projectRoot, file)
          const info = await lstat(source).catch(() => undefined)
          if (!info) return { path: file, deleted: true }
          if (!info.isFile() || info.isSymbolicLink()) {
            throw new ComposeWorkingSnapshotError(`当前工作区快照只支持普通文件：${file}`)
          }
          const bytes = await readFile(source)
          const destination = path.join(temporary, "files", file)
          await mkdir(path.dirname(destination), { recursive: true })
          await writeFile(destination, bytes)
          await chmod(destination, info.mode)
          return { path: file, deleted: false, sha256: hash(bytes), mode: info.mode }
        }),
      )
      await assertStableSnapshot(run.projectRoot, entries)
      const manifest: Manifest = { entries: entries.toSorted((a, b) => a.path.localeCompare(b.path)) }
      const encoded = JSON.stringify(manifest)
      await writeFile(path.join(temporary, "manifest.json"), encoded, "utf8")
      await rm(directory, { recursive: true, force: true })
      await rename(temporary, directory)
      return { path: directory, sha256: hash(Buffer.from(encoded)) }
    },
    {
      dir: path.join(run.projectRoot, ".workmesh", "state", "locks", "compose"),
      staleMs: 30_000,
      timeoutMs: 30_000,
      baseDelayMs: 20,
      maxDelayMs: 250,
    },
  ).finally(() => rm(temporary, { recursive: true, force: true }))
}

async function assertStableSnapshot(root: string, entries: Entry[]) {
  const expected = entries.map((entry) => entry.path).toSorted()
  const current = (await statusPaths(root)).toSorted()
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new ComposeWorkingSnapshotError("当前工作区在审批快照期间发生变化，请重新审批")
  }
  for (const entry of entries) {
    const info = await lstat(path.join(root, entry.path)).catch(() => undefined)
    if (entry.deleted) {
      if (info) throw new ComposeWorkingSnapshotError(`当前工作区文件在审批快照期间发生变化：${entry.path}`)
      continue
    }
    if (!info?.isFile() || info.isSymbolicLink() || info.mode !== entry.mode) {
      throw new ComposeWorkingSnapshotError(`当前工作区文件在审批快照期间发生变化：${entry.path}`)
    }
    if (hash(await readFile(path.join(root, entry.path))) !== entry.sha256) {
      throw new ComposeWorkingSnapshotError(`当前工作区文件在审批快照期间发生变化：${entry.path}`)
    }
  }
}

export async function applyComposeWorkingSnapshot(run: Compose.Info, target: string) {
  const directory = run.git.workingSnapshotPath
  const expectedSha256 = run.git.workingSnapshotSha256
  if (!directory || !expectedSha256) throw new ComposeWorkingSnapshotError("Compose 运行缺少当前工作区快照")
  const expected = path.join(run.projectRoot, ".workmesh", "state", "compose", run.id, "working-snapshot")
  if (!samePath(directory, expected)) throw new ComposeWorkingSnapshotError("Compose 当前工作区快照路径无效")
  const encoded = await readFile(path.join(directory, "manifest.json"), "utf8")
  if (hash(Buffer.from(encoded)) !== expectedSha256)
    throw new ComposeWorkingSnapshotError("Compose 当前工作区快照清单已变化")
  const manifest = JSON.parse(encoded) as Manifest
  for (const entry of manifest.entries) {
    const file = safeRelative(entry.path)
    const destination = path.join(target, file)
    if (entry.deleted) {
      await rm(destination, { force: true })
      continue
    }
    const bytes = await readFile(path.join(directory, "files", file))
    if (hash(bytes) !== entry.sha256) throw new ComposeWorkingSnapshotError(`Compose 当前工作区快照文件已变化：${file}`)
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, bytes)
    if (entry.mode !== undefined) await chmod(destination, entry.mode)
  }
}

async function statusPaths(directory: string) {
  const result = await Process.text(
    ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
    { cwd: directory },
  )
  return result.text
    .split("\0")
    .filter(Boolean)
    .map((entry) => safeRelative(entry.slice(3)))
    .filter((file) => file !== ".workmesh" && !file.startsWith(".workmesh/"))
}

function safeRelative(file: string) {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "")
  if (!normalized || path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new ComposeWorkingSnapshotError(`Compose 当前工作区快照路径越界：${file}`)
  }
  return normalized
}

function hash(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

function samePath(left: string, right: string) {
  const a = path.normalize(path.resolve(left))
  const b = path.normalize(path.resolve(right))
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}
