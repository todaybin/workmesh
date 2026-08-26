import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import { executeGitFinish } from "@/compose/git-finish"
import { createComposeService } from "@/compose/runtime"
import { createComposeWorkspace, removeComposeWorkspace } from "@/compose/workspace"
import { Process } from "@/util/process"
import { tmpdir } from "../fixture/fixture"
import { composeWorktreeDigest } from "@/compose/worktree-digest"
import { captureComposeWorkingSnapshot } from "@/compose/working-snapshot"

async function git(cwd: string, ...args: string[]) {
  return (await Process.text(["git", ...args], { cwd })).text.trim()
}

async function awaitingFinishRun(root: string) {
  await writeFile(path.join(root, ".git", "info", "exclude"), ".workmesh/\n", { encoding: "utf8", flag: "a" })
  const service = await createComposeService({ directory: root })
  const started = await service.start({
    task: "验证 Git Finish",
    baseBranch: await git(root, "branch", "--show-current"),
  })
  const worktree = path.join(root, ".workmesh", "worktrees", started.id)
  const branch = `workmesh/compose/${started.id}`
  await mkdir(path.dirname(worktree), { recursive: true })
  await git(root, "worktree", "add", "-b", branch, worktree, "HEAD")
  await service.update(started.id, "workspace-created", (run) => ({
    ...run,
    git: { ...run.git, branch, worktree },
  }))
  await service.transition({ id: started.id, phase: "design" })
  await service.transition({ id: started.id, phase: "awaiting_approval" })
  await service.approve(started.id)
  await service.transition({ id: started.id, phase: "implement" })
  await service.transition({ id: started.id, phase: "verify" })
  await service.transition({ id: started.id, phase: "review" })
  await service.transition({ id: started.id, phase: "finalize" })
  await service.awaitFinish(started.id)
  const reviewedTreeHash = await composeWorktreeDigest(worktree)
  const run = await service.update(started.id, "review-tree-bound", (current) => ({
    ...current,
    git: { ...current.git, reviewedTreeHash },
  }))
  return { service, run, worktree, branch }
}

describe("Compose Git Finish", () => {
  test("copies explicitly selected dirty working changes into a serial isolated workspace", async () => {
    await using tmp = await tmpdir({ git: true })
    await writeFile(path.join(tmp.path, "working.txt"), "当前未提交改动\n", "utf8")
    const service = await createComposeService({ directory: tmp.path })
    let run = await service.start({ task: "包含当前改动", baseDirty: true, maxConcurrent: 8 })
    const snapshot = await captureComposeWorkingSnapshot(run)
    run = await service.update(run.id, "workspace-strategy-selected", (current) => ({
      ...current,
      config: { ...current.config, maxConcurrent: 1 },
      git: {
        ...current.git,
        workspaceStrategy: "include_working",
        workingSnapshotPath: snapshot.path,
        workingSnapshotSha256: snapshot.sha256,
      },
    }))
    await writeFile(path.join(tmp.path, "working.txt"), "审批后的改动\n", "utf8")

    const workspace = await createComposeWorkspace(run)
    expect(await Bun.file(path.join(workspace.directory, "working.txt")).text()).toBe("当前未提交改动\n")
    expect(run.config.maxConcurrent).toBe(1)
  })

  test("refuses delivery when the worktree changed after review", async () => {
    await using tmp = await tmpdir({ git: true })
    const { run, worktree } = await awaitingFinishRun(tmp.path)
    await writeFile(path.join(worktree, "after-review.txt"), "未经 Review\n", "utf8")

    await expect(executeGitFinish(run, "local_merge")).rejects.toThrow("Review 通过后发生变化")
  })

  test("creates and removes only the project-local Compose workspace", async () => {
    await using tmp = await tmpdir({ git: true })
    await writeFile(path.join(tmp.path, ".git", "info", "exclude"), ".workmesh/\n", {
      encoding: "utf8",
      flag: "a",
    })
    const service = await createComposeService({ directory: tmp.path })
    let run = await service.start({ task: "本地 Worktree", baseSha: await git(tmp.path, "rev-parse", "HEAD") })

    const workspace = await createComposeWorkspace(run)
    expect(await createComposeWorkspace(run)).toEqual(workspace)
    run = await service.update(run.id, "workspace-created", (current) => ({
      ...current,
      git: { ...current.git, branch: workspace.branch, worktree: workspace.directory },
    }))

    expect(workspace.directory.startsWith(path.join(tmp.path, ".workmesh", "worktrees"))).toBe(true)
    expect((await git(tmp.path, "worktree", "list", "--porcelain")).replaceAll("/", "\\")).toContain(
      workspace.directory,
    )
    await removeComposeWorkspace(run, { deleteBranch: true, force: false })
    await removeComposeWorkspace(run, { deleteBranch: true, force: false })
    expect(await git(tmp.path, "branch", "--list", workspace.branch)).toBe("")
  })

  test("re-associates a pre-existing Compose branch with its expected directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const service = await createComposeService({ directory: tmp.path })
    const run = await service.start({ task: "恢复 Worktree" })
    const branch = `workmesh/compose/${run.id}`
    await git(tmp.path, "branch", branch, "HEAD")

    const workspace = await createComposeWorkspace(run)
    expect(workspace).toEqual({
      branch,
      directory: path.join(tmp.path, ".workmesh", "worktrees", run.id),
    })
    expect(await git(workspace.directory, "branch", "--show-current")).toBe(branch)
  })

  test("rejects Git finish before awaiting_finish without changing the repository", async () => {
    await using tmp = await tmpdir({ git: true })
    const service = await createComposeService({ directory: tmp.path })
    let run = await service.start({ task: "拒绝提前收尾" })
    const workspace = await createComposeWorkspace(run)
    run = await service.update(run.id, "workspace-created", (current) => ({
      ...current,
      git: { ...current.git, branch: workspace.branch, worktree: workspace.directory },
    }))
    await writeFile(path.join(workspace.directory, "early.txt"), "不能提前提交\n", "utf8")
    const before = await git(workspace.directory, "rev-parse", "HEAD")

    await expect(executeGitFinish(run, "local_merge")).rejects.toThrow("等待收尾确认")
    expect(await git(workspace.directory, "rev-parse", "HEAD")).toBe(before)
    expect(await git(workspace.directory, "status", "--porcelain=v1")).toContain("early.txt")
  })

  test("keep preserves uncommitted work without Git writes", async () => {
    await using tmp = await tmpdir({ git: true })
    const { run, worktree } = await awaitingFinishRun(tmp.path)
    await writeFile(path.join(worktree, "kept.txt"), "保留\n", "utf8")
    const before = await git(worktree, "rev-parse", "HEAD")

    const result = await executeGitFinish(run, "keep")

    expect(result).toMatchObject({ removeWorktree: false, deleteBranch: false, forceRemove: false })
    expect(await git(worktree, "rev-parse", "HEAD")).toBe(before)
    expect(await git(worktree, "status", "--porcelain=v1")).toContain("kept.txt")
  })

  test("local_merge commits only after confirmation and merges into the base branch", async () => {
    await using tmp = await tmpdir({ git: true })
    const { service, run: awaiting, worktree, branch } = await awaitingFinishRun(tmp.path)
    await writeFile(path.join(worktree, "merged.txt"), "已合并\n", "utf8")
    const reviewedTreeHash = await composeWorktreeDigest(worktree)
    const run = await service.update(awaiting.id, "review-tree-bound", (current) => ({
      ...current,
      git: { ...current.git, reviewedTreeHash },
    }))
    const before = await git(worktree, "rev-parse", "HEAD")

    const result = await executeGitFinish(run, "local_merge")

    expect(result).toMatchObject({ removeWorktree: true, deleteBranch: true, forceRemove: false })
    expect(await git(worktree, "rev-parse", "HEAD")).not.toBe(before)
    expect(await git(worktree, "rev-parse", "HEAD^{tree}")).toBe(reviewedTreeHash)
    const merged = await git(tmp.path, "rev-parse", "HEAD")
    await executeGitFinish(run, "local_merge")
    expect(await git(tmp.path, "rev-parse", "HEAD")).toBe(merged)
    expect(await git(tmp.path, "log", "-1", "--pretty=%s")).toContain(`Merge branch '${branch}'`)
    expect((await Bun.file(path.join(tmp.path, "merged.txt")).text()).trim()).toBe("已合并")
  })
})
