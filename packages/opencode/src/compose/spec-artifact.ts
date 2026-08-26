import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { Flock } from "@opencode-ai/core/util/flock"
import type { Compose } from "@opencode-ai/schema/compose"

export class ComposeSpecError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ComposeSpecError"
  }
}

export async function writeComposeSpecDraft(run: Compose.Info, content: string): Promise<Compose.Spec> {
  const value = content.trim()
  if (!value) throw new ComposeSpecError("Compose 规格内容不能为空")
  const directory = path.join(run.projectRoot, ".workmesh", "state", "compose", run.id)
  const draftPath = path.join(directory, "spec.md")
  const temporary = path.join(directory, `.spec.${process.pid}.${randomUUID()}.tmp`)
  return Flock.withLock(
    `compose-spec:${run.id}`,
    async () => {
      await mkdir(directory, { recursive: true })
      await writeFile(temporary, value + "\n", "utf8")
      await rename(temporary, draftPath)
      const bytes = await readFile(draftPath)
      return { draftPath, sha256: hash(bytes) }
    },
    {
      dir: path.join(run.projectRoot, ".workmesh", "state", "locks", "compose"),
      staleMs: 30_000,
      timeoutMs: 30_000,
      baseDelayMs: 20,
      maxDelayMs: 250,
    },
  ).finally(() => rm(temporary, { force: true }))
}

export async function approveComposeSpec(run: Compose.Info): Promise<Compose.Spec> {
  return Flock.withLock(`compose-spec:${run.id}`, () => approveLocked(run), {
    dir: path.join(run.projectRoot, ".workmesh", "state", "locks", "compose"),
    staleMs: 30_000,
    timeoutMs: 30_000,
    baseDelayMs: 20,
    maxDelayMs: 250,
  })
}

async function approveLocked(run: Compose.Info): Promise<Compose.Spec> {
  if (!run.spec) throw new ComposeSpecError("Compose 运行没有可批准的持久化规格")
  const expected = path.join(run.projectRoot, ".workmesh", "state", "compose", run.id, "spec.md")
  if (!samePath(run.spec.draftPath, expected)) throw new ComposeSpecError("Compose 草稿规格路径不属于当前运行")
  const info = await lstat(expected).catch(() => undefined)
  if (!info?.isFile() || info.isSymbolicLink()) throw new ComposeSpecError("Compose 草稿规格不是普通文件")
  const bytes = await readFile(expected)
  const sha256 = hash(bytes)
  if (sha256 !== run.spec.sha256) throw new ComposeSpecError("Compose 草稿规格已在审批前发生变化")
  const directory = path.join(run.projectRoot, "docs", "compose", "spec")
  const approvedPath = path.join(directory, `${slug(run.featureName ?? run.task)}-${run.id.slice(-8)}.md`)
  await mkdir(directory, { recursive: true })
  const existing = await lstat(approvedPath).catch(() => undefined)
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new ComposeSpecError("Compose 正式规格目标不是普通文件")
  }
  if (existing) {
    if (hash(await readFile(approvedPath)) !== sha256) throw new ComposeSpecError("Compose 正式规格路径已存在不同内容")
  } else {
    await writeFile(approvedPath, bytes, { flag: "wx" })
  }
  return {
    ...run.spec,
    approvedPath,
    approvedSha256: sha256,
    temporaryProjectCopy: run.spec.temporaryProjectCopy ?? !existing,
  }
}

export async function verifyApprovedComposeSpec(run: Compose.Info, root: string) {
  const approvedPath = run.spec?.approvedPath
  const approvedSha256 = run.spec?.approvedSha256
  if (!approvedPath || !approvedSha256) throw new ComposeSpecError("Compose 运行缺少已批准规格或内容哈希")
  const relative = path.relative(run.projectRoot, path.resolve(approvedPath))
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ComposeSpecError("Compose 正式规格不在当前项目内")
  }
  const file = path.join(root, relative)
  const info = await lstat(file).catch(() => undefined)
  if (!info?.isFile() || info.isSymbolicLink()) throw new ComposeSpecError("Compose 已批准规格文件缺失")
  if (hash(await readFile(file)) !== approvedSha256) throw new ComposeSpecError("Compose 已批准规格内容发生变化")
  return file
}

export async function discardTemporaryApprovedSpec(run: Compose.Info, spec: Compose.Spec) {
  if (!spec.temporaryProjectCopy || !spec.approvedPath || !spec.approvedSha256) return
  const root = path.join(run.projectRoot, "docs", "compose", "spec")
  const relative = path.relative(root, path.resolve(spec.approvedPath))
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return
  const info = await lstat(spec.approvedPath).catch(() => undefined)
  if (!info?.isFile() || info.isSymbolicLink()) return
  if (hash(await readFile(spec.approvedPath)) !== spec.approvedSha256) return
  await rm(spec.approvedPath, { force: true })
}

function hash(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

function slug(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "compose"
  )
}

function samePath(left: string, right: string) {
  const a = path.normalize(path.resolve(left))
  const b = path.normalize(path.resolve(right))
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}
