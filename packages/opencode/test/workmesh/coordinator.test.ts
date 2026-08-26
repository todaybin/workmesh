import path from "node:path"
import { mkdir } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import { ManagedRuntime } from "effect"
import { tmpdir } from "../fixture/fixture"
import { Database } from "@opencode-ai/core/database/database"
import { createLocalCoordinator, type LocalCoordinator } from "@/workmesh/coordinator"
import { createWorkMeshCoordinator, disposeWorkMeshCoordinator } from "@/workmesh/coordinator-service"
import { WorkMeshRuntimeLayout } from "@/workmesh/runtime-layout"

describe("WorkMesh local SQLite coordinator", () => {
  test("automatically creates the project database and delivers idempotent messages", async () => {
    await using project = await tmpdir({ git: true })
    const database = WorkMeshRuntimeLayout.layoutForRoot(project.path).database
    expect(await Bun.file(database).exists()).toBe(false)

    const coordinator = await createWorkMeshCoordinator(project.path)
    try {
      await coordinator.register({
        terminalId: "a",
        displayName: "Agent A",
        capabilities: ["docs"],
        status: "online",
        workspaceMode: "shared",
      })
      await coordinator.register({
        terminalId: "b",
        displayName: "Agent B",
        capabilities: ["code"],
        status: "online",
        workspaceMode: "locked",
      })
      const first = await coordinator.sendMessage({
        senderTerminalId: "a",
        recipientTerminalId: "b",
        message: "接口字段已更新",
        idempotencyKey: "once",
      })
      const duplicate = await coordinator.sendMessage({
        senderTerminalId: "a",
        recipientTerminalId: "b",
        message: "不会重复",
        idempotencyKey: "once",
      })
      expect(duplicate.id).toBe(first.id)
      expect(first.execution).toBeUndefined()
      expect((await coordinator.listMessages("b")).map((item) => item.message)).toEqual(["接口字段已更新"])
    } finally {
      await disposeWorkMeshCoordinator(project.path)
    }

    expect(await Bun.file(database).exists()).toBe(true)
  })

  test("shares terminal state and events between independent database connections", async () => {
    await using project = await tmpdir({ git: true })
    await withTwoCoordinators(project.path, async (sender, receiver) => {
      await sender.register({
        terminalId: "sender",
        displayName: "Sender",
        capabilities: [],
        status: "online",
        workspaceMode: "shared",
      })
      await receiver.register({
        terminalId: "receiver",
        displayName: "Receiver",
        capabilities: [],
        status: "online",
        workspaceMode: "shared",
      })
      const task = await sender.sendMessage({
        senderTerminalId: "sender",
        recipientTerminalId: "receiver",
        message: "执行检查",
        execution: { kind: "prompt", agent: "plan" },
      })
      expect((await receiver.listMessages("receiver"))[0]?.execution).toEqual({ kind: "prompt", agent: "plan" })
      const command = await sender.sendMessage({
        senderTerminalId: "sender",
        recipientTerminalId: "receiver",
        message: "/compose 修复登录流程",
        execution: { kind: "command", agent: "build", name: "compose", arguments: "修复登录流程" },
      })
      expect((await receiver.listMessages("receiver"))[1]?.execution).toEqual({
        kind: "command",
        agent: "build",
        name: "compose",
        arguments: "修复登录流程",
      })
      await receiver.claimMessage("receiver", task.id)
      await receiver.reportMessageEvent({
        terminalId: "receiver",
        messageId: task.id,
        sequence: 1,
        kind: "assistant.text",
        content: "正在检查",
        metadata: {},
      })
      await receiver.reportMessageEvent({
        terminalId: "receiver",
        messageId: task.id,
        sequence: 2,
        kind: "shell.output",
        content: "test passed",
        metadata: { command: "bun test" },
      })

      const events = await sender.listMessageEvents("sender", "receiver")
      expect(events.items.map((item) => [item.kind, item.content])).toEqual([
        ["assistant.text", "正在检查"],
        ["shell.output", "test passed"],
      ])
      expect(command.status).toBe("queued")
    })
  })

  test("claims a queued task once across connections", async () => {
    await using project = await tmpdir({ git: false })
    await withTwoCoordinators(project.path, async (first, second) => {
      await first.register({
        terminalId: "sender",
        displayName: "Sender",
        capabilities: [],
        status: "online",
        workspaceMode: "shared",
      })
      await first.register({
        terminalId: "worker",
        displayName: "Worker",
        capabilities: [],
        status: "online",
        workspaceMode: "shared",
      })
      const task = await first.sendMessage({
        senderTerminalId: "sender",
        recipientTerminalId: "worker",
        message: "执行检查",
      })
      const claims = await Promise.allSettled([
        first.claimMessage("worker", task.id),
        second.claimMessage("worker", task.id),
      ])
      expect(claims.filter((item) => item.status === "fulfilled")).toHaveLength(1)
      expect((await first.completeMessage("worker", task.id, "检查完成")).status).toBe("completed")
    })
  })

  test("detects overlapping write intents", async () => {
    await using project = await tmpdir({ git: false })
    await withCoordinator(project.path, async (coordinator) => {
      await coordinator.register({
        terminalId: "docs",
        displayName: "Docs",
        capabilities: [],
        status: "online",
        workspaceMode: "shared",
      })
      await coordinator.register({
        terminalId: "review",
        displayName: "Review",
        capabilities: [],
        status: "online",
        workspaceMode: "locked",
      })
      expect(
        (
          await coordinator.claimIntent({
            terminalId: "docs",
            paths: ["docs/spec"],
            mode: "write",
            workspaceMode: "shared",
          })
        ).status,
      ).toBe("active")
      expect(
        (
          await coordinator.claimIntent({
            terminalId: "review",
            paths: ["docs/spec/a.md"],
            mode: "write",
            workspaceMode: "locked",
          })
        ).status,
      ).toBe("conflict")
      await expect(
        coordinator.claimIntent({ terminalId: "docs", paths: ["../outside"], mode: "write", workspaceMode: "shared" }),
      ).rejects.toThrow("超出当前项目")
    })
  })

  test("imports and removes the legacy JSON coordinator", async () => {
    await using project = await tmpdir({ git: false })
    const legacy = path.join(project.path, ".workmesh", "coordinator")
    await mkdir(legacy, { recursive: true })
    await Bun.write(
      path.join(legacy, "snapshot.json"),
      JSON.stringify({
        version: 1,
        projectRoot: project.path,
        epoch: 0,
        sequence: 0,
        terminals: {
          a: {
            terminalId: "a",
            projectRoot: project.path,
            displayName: "A",
            capabilities: [],
            status: "online",
            workspaceMode: "shared",
            intents: [],
            lastHeartbeatAt: new Date().toISOString(),
            coordinatorMode: "offline",
          },
        },
        messages: {},
        events: [],
      }),
    )

    await withCoordinator(project.path, async (coordinator) => {
      expect((await coordinator.listAgents()).map((item) => item.terminalId)).toEqual(["a"])
    })
    expect(await Bun.file(path.join(legacy, "snapshot.json")).exists()).toBe(false)
  })

  test("rejects messages larger than 8 KiB", async () => {
    await using project = await tmpdir({ git: true })
    await withCoordinator(project.path, async (coordinator) => {
      await coordinator.register({
        terminalId: "a",
        displayName: "A",
        capabilities: [],
        status: "online",
        workspaceMode: "shared",
      })
      await coordinator.register({
        terminalId: "b",
        displayName: "B",
        capabilities: [],
        status: "online",
        workspaceMode: "shared",
      })
      await expect(
        coordinator.sendMessage({ senderTerminalId: "a", recipientTerminalId: "b", message: "x".repeat(8193) }),
      ).rejects.toThrow("8 KiB")
    })
  })
})

async function withCoordinator(projectRoot: string, use: (coordinator: LocalCoordinator) => Promise<void>) {
  const layout = WorkMeshRuntimeLayout.layoutForRoot(projectRoot)
  await mkdir(layout.data, { recursive: true })
  const runtime = ManagedRuntime.make(Database.layerFromPath(layout.database))
  try {
    const database = await runtime.runPromise(Database.Service)
    await use(await createLocalCoordinator(projectRoot, database.db))
  } finally {
    await runtime.dispose()
  }
}

async function withTwoCoordinators(
  projectRoot: string,
  use: (first: LocalCoordinator, second: LocalCoordinator) => Promise<void>,
) {
  const layout = WorkMeshRuntimeLayout.layoutForRoot(projectRoot)
  await mkdir(layout.data, { recursive: true })
  const firstRuntime = ManagedRuntime.make(Database.layerFromPath(layout.database))
  const secondRuntime = ManagedRuntime.make(Database.layerFromPath(layout.database))
  try {
    const first = await firstRuntime.runPromise(Database.Service)
    const second = await secondRuntime.runPromise(Database.Service)
    await use(await createLocalCoordinator(projectRoot, first.db), await createLocalCoordinator(projectRoot, second.db))
  } finally {
    await Promise.all([firstRuntime.dispose(), secondRuntime.dispose()])
  }
}
