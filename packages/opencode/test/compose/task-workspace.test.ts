import path from "node:path"
import { expect, test } from "bun:test"
import { lstat, writeFile } from "node:fs/promises"
import { createComposeService } from "@/compose/runtime"
import { createComposeWorkspace } from "@/compose/workspace"
import {
  applyComposeTaskChanges,
  createComposeTaskWorkspace,
  removeComposeTaskWorkspaces,
} from "@/compose/task-workspace"
import { Process } from "@/util/process"
import { tmpdir } from "../fixture/fixture"

test("runs disjoint task changes in isolated worktrees and applies only declared files", async () => {
  await using tmp = await tmpdir({ git: true })
  const service = await createComposeService({ directory: tmp.path })
  let run = await service.start({ task: "并行任务" })
  await service.transition({ id: run.id, phase: "design" })
  await service.transition({ id: run.id, phase: "awaiting_approval" })
  run = await service.approve(run.id)
  const integration = await createComposeWorkspace(run)
  run = await service.update(run.id, "workspace-created", (current) => ({
    ...current,
    git: { ...current.git, branch: integration.branch, worktree: integration.directory },
  }))
  await writeFile(path.join(integration.directory, "shared.txt"), "baseline", "utf8")
  const task = (id: string, file: string) => ({
    id,
    description: id,
    acceptance: ["文件已生成"],
    dependsOn: [],
    covers: [id],
    files: [file],
    status: "pending" as const,
    attempt: 0,
  })
  const first = await createComposeTaskWorkspace(run, task("first", "first.txt"))
  const second = await createComposeTaskWorkspace(run, task("second", "second.txt"))
  expect(await Bun.file(path.join(first.directory, "shared.txt")).text()).toBe("baseline")
  await writeFile(path.join(first.directory, "first.txt"), "first", "utf8")
  await writeFile(path.join(second.directory, "second.txt"), "second", "utf8")

  const applied = await applyComposeTaskChanges(integration.directory, [first, second])
  expect(applied).toEqual([
    { taskID: "first", paths: ["first.txt"] },
    { taskID: "second", paths: ["second.txt"] },
  ])
  expect(await Bun.file(path.join(integration.directory, "first.txt")).text()).toBe("first")
  expect(await Bun.file(path.join(integration.directory, "second.txt")).text()).toBe("second")

  await writeFile(path.join(first.directory, "outside.txt"), "outside", "utf8")
  await expect(applyComposeTaskChanges(integration.directory, [first])).rejects.toThrow("未声明文件")

  await removeComposeTaskWorkspaces(run)
  await removeComposeTaskWorkspaces(run)
  expect(await lstat(first.directory).catch(() => undefined)).toBeUndefined()
  expect(await lstat(second.directory).catch(() => undefined)).toBeUndefined()
  const branches = await Process.text(["git", "branch", "--list", `workmesh/compose/${run.id}-*`], {
    cwd: tmp.path,
  })
  expect(branches.text.trim()).toBe("")
})

test("rejects actual overlap between task worktrees before applying changes", async () => {
  await using tmp = await tmpdir({ git: true })
  const service = await createComposeService({ directory: tmp.path })
  let run = await service.start({ task: "冲突任务" })
  await service.transition({ id: run.id, phase: "design" })
  await service.transition({ id: run.id, phase: "awaiting_approval" })
  run = await service.approve(run.id)
  const integration = await createComposeWorkspace(run)
  run = await service.update(run.id, "workspace-created", (current) => ({
    ...current,
    git: { ...current.git, branch: integration.branch, worktree: integration.directory },
  }))
  const task = (id: string) => ({
    id,
    description: id,
    acceptance: ["文件已生成"],
    dependsOn: [],
    covers: [id],
    files: ["shared.txt"],
    status: "pending" as const,
    attempt: 0,
  })
  const first = await createComposeTaskWorkspace(run, task("first"))
  const second = await createComposeTaskWorkspace(run, task("second"))
  await writeFile(path.join(first.directory, "shared.txt"), "first", "utf8")
  await writeFile(path.join(second.directory, "shared.txt"), "second", "utf8")

  await expect(applyComposeTaskChanges(integration.directory, [first, second])).rejects.toThrow("写入冲突")
  expect(await lstat(path.join(integration.directory, "shared.txt")).catch(() => undefined)).toBeUndefined()
  await removeComposeTaskWorkspaces(run)
})
