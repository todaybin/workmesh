import path from "node:path"
import { randomUUID } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import { Process } from "@/util/process"

export class ComposeWorktreeDigestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ComposeWorktreeDigestError"
  }
}

// Build a Git tree through an isolated index. The returned object ID is a
// durable, directly committable snapshot and never mutates the real index.
export async function composeWorktreeDigest(directory: string) {
  const temporary = path.join(path.dirname(directory), ".compose-index")
  const index = path.join(temporary, `compose-index-${process.pid}-${randomUUID()}`)
  const env = { GIT_INDEX_FILE: index }
  await mkdir(temporary, { recursive: true })
  try {
    await git(["git", "read-tree", "HEAD"], directory, env)
    await git(["git", "add", "--all"], directory, env)
    return (await git(["git", "write-tree"], directory, env)).text.trim()
  } finally {
    await rm(index, { force: true })
    await rm(`${index}.lock`, { force: true })
  }
}

async function git(command: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const result = await Process.text(command, { cwd, env, nothrow: true })
  if (result.code !== 0) {
    const detail = result.stderr.toString("utf8").trim() || result.text.trim() || command.join(" ")
    throw new ComposeWorktreeDigestError(`无法生成 Compose Git tree：${detail}`)
  }
  return result
}
