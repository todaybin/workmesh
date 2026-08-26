import path from "node:path"
import { expect, test } from "bun:test"
import { lstat, writeFile } from "node:fs/promises"
import { approveComposeSpec, verifyApprovedComposeSpec, writeComposeSpecDraft } from "@/compose/spec-artifact"
import { createComposeService } from "@/compose/runtime"
import { createComposeWorkspace } from "@/compose/workspace"
import { tmpdir } from "../fixture/fixture"

test("persists the approved specification with an immutable content hash", async () => {
  await using tmp = await tmpdir({ git: true })
  const service = await createComposeService({ directory: tmp.path })
  let run = await service.start({ task: "持久化审批规格" })
  const spec = await writeComposeSpecDraft(run, "# 规格\n\n## 验证\n\n运行定向测试。")
  run = await service.update(run.id, "spec-draft-written", (current) => ({ ...current, spec }))

  const approved = await approveComposeSpec(run)
  expect(approved.approvedSha256).toBe(spec.sha256)
  expect(approved.approvedPath).toStartWith(path.join(tmp.path, "docs", "compose", "spec"))
  expect(await Bun.file(approved.approvedPath!).text()).toBe(await Bun.file(spec.draftPath).text())
  expect(await approveComposeSpec({ ...run, spec: approved })).toEqual(approved)
  expect(await verifyApprovedComposeSpec({ ...run, spec: approved }, tmp.path)).toBe(approved.approvedPath!)
  run = await service.update(run.id, "spec-approved", (current) => ({
    ...current,
    spec: approved,
    git: { ...current.git, workspaceStrategy: "clean_head" },
  }))
  const workspace = await createComposeWorkspace(run)
  expect(await lstat(approved.approvedPath!).catch(() => undefined)).toBeUndefined()
  expect(await verifyApprovedComposeSpec(run, workspace.directory)).toBe(
    path.join(workspace.directory, path.relative(tmp.path, approved.approvedPath!)),
  )
})

test("rejects a draft changed after it was presented for approval", async () => {
  await using tmp = await tmpdir({ git: true })
  const service = await createComposeService({ directory: tmp.path })
  const run = await service.start({ task: "拒绝审批篡改" })
  const spec = await writeComposeSpecDraft(run, "原始规格")
  await writeFile(spec.draftPath, "审批前被修改\n", "utf8")

  await expect(approveComposeSpec({ ...run, spec })).rejects.toThrow("审批前发生变化")
})
