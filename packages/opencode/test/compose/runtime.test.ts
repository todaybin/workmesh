import path from "node:path"
import { appendFile, mkdir, readFile, utimes, writeFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import { Hash } from "@opencode-ai/core/util/hash"
import { createComposeService } from "@/compose/runtime"
import { tmpdir } from "../fixture/fixture"

describe("Compose runtime", () => {
  test("persists automatic runs and enforces the approval boundary", async () => {
    await using tmp = await tmpdir({ git: true })
    const updates: string[] = []
    const service = await createComposeService({
      directory: tmp.path,
      onUpdated: (run) => {
        updates.push(`${run.phase}:${run.status}`)
      },
    })

    const started = await service.start({ task: "实现 Compose", language: "zh-CN", baseBranch: "dev" })
    expect(started.phase).toBe("brainstorm")
    expect(started.config.maxConcurrent).toBe(8)

    await service.transition({ id: started.id, phase: "design" })
    const awaiting = await service.transition({ id: started.id, phase: "awaiting_approval" })
    expect(awaiting.status).toBe("awaiting_approval")

    const revised = await service.revise({ id: started.id, instruction: "补充 Windows 验证" })
    expect(revised.revision).toBe(1)
    expect(revised.amendments[0]?.instruction).toBe("补充 Windows 验证")

    const approved = await service.approve(started.id)
    expect(approved.phase).toBe("workspace")
    expect(approved.approvedAt).toBeNumber()
    expect((await service.approve(started.id)).journalSeq).toBe(approved.journalSeq)
    expect(updates).toEqual([
      "brainstorm:running",
      "design:running",
      "awaiting_approval:awaiting_approval",
      "awaiting_approval:awaiting_approval",
      "workspace:running",
    ])

    const persisted = JSON.parse(await readFile(path.join(service.layout.composeState, started.id, "run.json"), "utf8"))
    expect(persisted.phase).toBe("workspace")
    expect((await service.list()).map((run) => run.id)).toEqual([started.id])
  })

  test("resumes cancelled and failed runs from their durable checkpoint", async () => {
    await using tmp = await tmpdir({ git: true })
    const service = await createComposeService({ directory: tmp.path })
    const started = await service.start({ task: "可恢复流程", mode: "interactive" })
    await service.transition({ id: started.id, phase: "grill" })

    const cancelled = await service.cancel(started.id)
    expect(cancelled).toMatchObject({ phase: "cancelled", status: "cancelled", resumePhase: "grill" })
    expect(await service.resume(started.id)).toMatchObject({ phase: "grill", status: "running" })

    const failed = await service.fail(started.id, "验证失败")
    expect(failed).toMatchObject({ phase: "failed", status: "failed", resumePhase: "grill" })
    expect(await service.resume(started.id)).toMatchObject({ phase: "grill", status: "running" })
  })

  test("reclaims a running phase after the caller obtains a new execution lease", async () => {
    await using tmp = await tmpdir({ git: true })
    const service = await createComposeService({ directory: tmp.path })
    const started = await service.start({ task: "崩溃恢复" })
    await service.transition({ id: started.id, phase: "design" })
    await service.transition({ id: started.id, phase: "awaiting_approval" })
    const approved = await service.approve(started.id)

    expect(await service.resume(approved.id)).toMatchObject({ phase: "workspace", status: "running" })
  })

  test("persists approval before lease contention and later recovers the running checkpoint", async () => {
    await using tmp = await tmpdir({ git: true })
    const first = await createComposeService({ directory: tmp.path })
    const second = await createComposeService({ directory: tmp.path })
    const started = await first.start({ task: "审批后恢复" })
    await first.transition({ id: started.id, phase: "design" })
    await first.transition({ id: started.id, phase: "awaiting_approval" })
    await using blocker = await first.acquireExecutionLease(started.id, { ownerID: "terminal-a" })

    await expect(
      second.approveForExecution(started.id, { ownerID: "terminal-b", timeoutMs: 50 }),
    ).rejects.toMatchObject({ code: "locked" })
    expect(await second.get(started.id)).toMatchObject({ phase: "workspace", status: "running" })

    await blocker.release()
    await using recovered = (await second.recoverExecution(started.id, { ownerID: "terminal-b" })).lease
    expect((await second.get(started.id)).status).toBe("running")
  })

  test("reclaims a running checkpoint after a stale execution lease", async () => {
    await using tmp = await tmpdir({ git: true })
    const service = await createComposeService({ directory: tmp.path })
    const started = await service.start({ task: "租约失效恢复" })
    const lock = path.join(service.layout.composeLocks, `${Hash.fast(`compose-execution:${started.id}`)}.lock`)
    await mkdir(lock, { recursive: true })
    await writeFile(path.join(lock, "meta.json"), JSON.stringify({ token: "crashed" }), "utf8")
    await writeFile(path.join(lock, "heartbeat"), "", "utf8")
    const stale = new Date(Date.now() - 31_000)
    await utimes(path.join(lock, "heartbeat"), stale, stale)

    const recovered = await service.recoverExecution(started.id, { ownerID: "terminal-after-crash" })
    expect(recovered.run).toMatchObject({ phase: "brainstorm", status: "running" })
    await recovered.lease.release()
  })

  test("validates task dependencies and updates tasks atomically", async () => {
    await using tmp = await tmpdir({ git: true })
    const service = await createComposeService({ directory: tmp.path })
    const started = await service.start({ task: "任务图" })
    const task = (id: string, dependsOn: string[] = []) => ({
      id,
      description: id,
      acceptance: [`${id} 已完成`],
      dependsOn,
      covers: [id],
      files: [`${id}.txt`],
      status: "pending" as const,
      attempt: 0,
    })

    await expect(service.setTasks(started.id, [task("a", ["b"]), task("b", ["a"])])).rejects.toThrow("循环依赖")

    await service.setTasks(started.id, [task("a"), task("b", ["a"])])
    const updated = await service.updateTask({
      id: started.id,
      taskID: "a",
      patch: { status: "completed", attempt: 1 },
    })
    expect(updated.tasks.find((item) => item.id === "a")).toMatchObject({ status: "completed", attempt: 1 })
  })

  test("persists retry budgets and pending fix phase atomically across service recovery", async () => {
    await using tmp = await tmpdir({ git: true })
    const first = await createComposeService({ directory: tmp.path })
    const started = await first.start({ task: "持久化重试次数" })
    await first.update(started.id, "verification-attempt", (run) => ({ ...run, verificationAttempts: 2 }))
    await first.update(started.id, "review-fix-attempt", (run) => ({
      ...run,
      phase: "implement",
      reviewFixAttempts: 1,
      pendingFixKind: "review",
      pendingFixes: ["修复审批绕过"],
    }))

    const recovered = await createComposeService({ directory: tmp.path })
    expect(await recovered.get(started.id)).toMatchObject({
      verificationAttempts: 2,
      phase: "implement",
      reviewFixAttempts: 1,
      pendingFixKind: "review",
      pendingFixes: ["修复审批绕过"],
    })
  })

  test("rejects stale specification revisions during save and approval", async () => {
    await using tmp = await tmpdir({ git: true })
    const service = await createComposeService({ directory: tmp.path })
    let run = await service.start({ task: "规格 CAS" })
    await service.transition({ id: run.id, phase: "design" })
    run = await service.transition({ id: run.id, phase: "awaiting_approval" })
    const spec = { draftPath: "draft.md", sha256: "sha" }
    run = await service.saveSpec({ id: run.id, revision: 0, spec })
    await service.revise({ id: run.id, instruction: "更新规格" })

    await expect(service.saveSpec({ id: run.id, revision: 0, spec })).rejects.toThrow("修订版本已变化")
    await expect(
      service.approveSpecForExecution({
        id: run.id,
        revision: 0,
        spec: { ...spec, approvedPath: "approved.md", approvedSha256: "sha" },
        strategy: "clean_head",
        baseDirty: false,
      }),
    ).rejects.toThrow("修订版本已变化")
  })

  test("recovers a damaged snapshot from the append-only journal", async () => {
    await using tmp = await tmpdir({ git: true })
    const service = await createComposeService({ directory: tmp.path })
    const started = await service.start({ task: "恢复状态" })
    await service.transition({ id: started.id, phase: "design" })
    await writeFile(path.join(service.layout.composeState, started.id, "run.json"), "{损坏", "utf8")

    expect(await service.get(started.id)).toMatchObject({ id: started.id, phase: "design", journalSeq: 2 })
  })

  test("repairs an incomplete journal tail before the next checkpoint", async () => {
    await using tmp = await tmpdir({ git: true })
    const service = await createComposeService({ directory: tmp.path })
    const started = await service.start({ task: "修复 Journal" })
    const directory = path.join(service.layout.composeState, started.id)
    await appendFile(path.join(directory, "journal.jsonl"), '{"seq":2', "utf8")

    await service.transition({ id: started.id, phase: "design" })
    await writeFile(path.join(directory, "run.json"), "{损坏", "utf8")
    expect(await service.get(started.id)).toMatchObject({ phase: "design", journalSeq: 2 })
  })

  test("allows only one execution lease per run", async () => {
    await using tmp = await tmpdir({ git: true })
    const first = await createComposeService({ directory: tmp.path })
    const second = await createComposeService({ directory: tmp.path })
    const started = await first.start({ task: "租约" })
    await using lease = await first.acquireExecutionLease(started.id, { ownerID: "terminal-a" })

    await expect(
      second.acquireExecutionLease(started.id, { ownerID: "terminal-b", timeoutMs: 50 }),
    ).rejects.toMatchObject({ code: "locked" })
    expect(lease.ownerID).toBe("terminal-a")
  })

  test("fences a previous owner after another service takes over execution", async () => {
    await using tmp = await tmpdir({ git: true })
    const first = await createComposeService({ directory: tmp.path })
    const second = await createComposeService({ directory: tmp.path })
    const started = await first.start({ task: "执行所有权接管" })
    await first.transition({ id: started.id, phase: "design" })
    await first.transition({ id: started.id, phase: "awaiting_approval" })
    await first.approve(started.id)
    const previous = await first.acquireExecutionLease(started.id, { ownerID: "terminal-a" })
    expect(await first.get(started.id)).toMatchObject({ executionOwnerID: "terminal-a" })
    await previous.release()

    const current = await second.acquireExecutionLease(started.id, { ownerID: "terminal-b" })
    expect(await second.assertExecutionLease(started.id, current)).toMatchObject({
      executionOwnerID: "terminal-b",
    })
    await expect(first.assertExecutionLease(started.id, previous)).rejects.toMatchObject({ code: "locked" })
    await expect(
      first.update(started.id, "stale-owner-update", (run) => ({ ...run, task: "旧所有者写入" }), previous),
    ).rejects.toMatchObject({ code: "locked" })
    await expect(
      first.update(started.id, "unleased-update", (run) => ({ ...run, task: "无租约写入" })),
    ).rejects.toMatchObject({ code: "locked" })

    const updated = await second.update(
      started.id,
      "current-owner-update",
      (run) => ({ ...run, task: "当前所有者写入" }),
      current,
    )
    expect(updated).toMatchObject({ task: "当前所有者写入", executionOwnerID: "terminal-b" })
    await current.release()
  })

  test("serializes cancellation with active execution", async () => {
    await using tmp = await tmpdir({ git: true })
    const first = await createComposeService({ directory: tmp.path })
    const second = await createComposeService({ directory: tmp.path })
    const started = await first.start({ task: "取消并发执行" })
    await using execution = await first.acquireExecutionLease(started.id, { ownerID: "executor" })

    await expect(second.cancel(started.id, { ownerID: "canceller", timeoutMs: 50 })).rejects.toMatchObject({
      code: "locked",
    })
    expect((await first.get(started.id)).status).toBe("running")

    await execution.release()
    expect(await second.cancel(started.id, { ownerID: "canceller" })).toMatchObject({
      phase: "cancelled",
      status: "cancelled",
    })
  })

  test("checks awaiting_finish before granting an exclusive finish lease", async () => {
    await using tmp = await tmpdir({ git: true })
    const first = await createComposeService({ directory: tmp.path })
    const second = await createComposeService({ directory: tmp.path })
    const started = await first.start({ task: "安全收尾" })

    await expect(first.acquireFinishLease({ id: started.id, action: "keep" })).rejects.toMatchObject({
      code: "invalid-transition",
    })
    await using execution = await first.acquireExecutionLease(started.id)
    await execution.release()

    await first.transition({ id: started.id, phase: "design" })
    await first.transition({ id: started.id, phase: "awaiting_approval" })
    await first.approve(started.id)
    const driver = await first.acquireExecutionLease(started.id, { ownerID: "phase-driver" })
    await first.transition({ id: started.id, phase: "implement" }, driver)
    await first.transition({ id: started.id, phase: "verify" }, driver)
    await first.transition({ id: started.id, phase: "review" }, driver)
    await first.transition({ id: started.id, phase: "report" }, driver)
    await first.awaitFinish(started.id, driver)
    await driver.release()

    const finish = await first.acquireFinishLease({ id: started.id, action: "keep" }, { ownerID: "finish-a" })
    await expect(
      second.acquireFinishLease({ id: started.id, action: "keep" }, { ownerID: "finish-b", timeoutMs: 50 }),
    ).rejects.toMatchObject({ code: "locked" })
    await expect(second.cancel(started.id, { ownerID: "cancel", timeoutMs: 50 })).rejects.toMatchObject({
      code: "locked",
    })
    await finish.lease.release()
  })

  test("recovers finish cleanup without repeating a completed Git action", async () => {
    await using tmp = await tmpdir({ git: true })
    const service = await createComposeService({ directory: tmp.path })
    const started = await service.start({ task: "收尾", mode: "interactive" })
    await service.transition({ id: started.id, phase: "spec" })
    await service.transition({ id: started.id, phase: "awaiting_approval" })
    await service.approve(started.id)
    await service.transition({ id: started.id, phase: "implement" })
    await service.transition({ id: started.id, phase: "verify" })
    await service.transition({ id: started.id, phase: "review" })
    await service.transition({ id: started.id, phase: "finalize" })
    await service.awaitFinish(started.id)

    const first = await service.acquireFinishLease({ id: started.id, action: "discard" })
    expect(first).toMatchObject({ needsGit: true, needsCleanup: true })
    const gitResult = {
      message: "已放弃 Compose 运行",
      removeWorktree: true,
      deleteBranch: true,
      forceRemove: true,
    }
    await service.recordFinishGitResult({ id: started.id, action: "discard", ...gitResult }, first.lease)
    await first.lease.release()

    const recoveredService = await createComposeService({ directory: tmp.path })
    await expect(recoveredService.acquireFinishLease({ id: started.id, action: "keep" })).rejects.toMatchObject({
      code: "invalid-transition",
    })
    const recovered = await recoveredService.acquireFinishLease({ id: started.id, action: "discard" })
    expect(recovered).toMatchObject({ needsGit: false, needsCleanup: true, result: gitResult })
    await expect(
      recoveredService.acquireFinishLease({ id: started.id, action: "keep" }, { timeoutMs: 50 }),
    ).rejects.toMatchObject({ code: "locked" })
    await recoveredService.recordFinishCleanup({ id: started.id, action: "discard" }, recovered.lease)
    const finished = await recoveredService.finish({ id: started.id, action: "discard" }, recovered.lease)
    await recovered.lease.release()

    expect(finished).toMatchObject({ phase: "discarded", status: "discarded", git: { finishAction: "discard" } })
    await expect(service.cancel(started.id)).rejects.toThrow("已结束")
  })

  test("requires durable Git and cleanup checkpoints before completing finish", async () => {
    await using tmp = await tmpdir({ git: true })
    const service = await createComposeService({ directory: tmp.path })
    const started = await service.start({ task: "收尾检查点", mode: "interactive" })
    await service.transition({ id: started.id, phase: "spec" })
    await service.transition({ id: started.id, phase: "awaiting_approval" })
    await service.approve(started.id)
    await service.transition({ id: started.id, phase: "implement" })
    await service.transition({ id: started.id, phase: "verify" })
    await service.transition({ id: started.id, phase: "review" })
    await service.transition({ id: started.id, phase: "finalize" })
    await service.awaitFinish(started.id)

    const unrelated = await service.acquireExecutionLease(started.id)
    await expect(service.finish({ id: started.id, action: "keep" }, unrelated)).rejects.toThrow("尚未开始")
    await unrelated.release()
    const leased = await service.acquireFinishLease({ id: started.id, action: "keep" })
    await expect(service.finish({ id: started.id, action: "keep" }, leased.lease)).rejects.toThrow("清理尚未完成")
    await service.recordFinishGitResult(
      {
        id: started.id,
        action: "keep",
        message: "已保留 Compose 分支和 Worktree",
        removeWorktree: false,
        deleteBranch: false,
        forceRemove: false,
      },
      leased.lease,
    )
    await expect(service.finish({ id: started.id, action: "keep" }, leased.lease)).rejects.toThrow("清理尚未完成")
    await service.recordFinishCleanup({ id: started.id, action: "keep" }, leased.lease)
    const finished = await service.finish({ id: started.id, action: "keep" }, leased.lease)
    await leased.lease.release()

    expect(finished).toMatchObject({ phase: "completed", status: "completed", git: { finishAction: "keep" } })
    await expect(service.cancel(started.id)).rejects.toThrow("已结束")
  })
})
