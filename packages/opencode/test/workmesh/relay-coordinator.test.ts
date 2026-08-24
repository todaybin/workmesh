import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { Effect, ManagedRuntime } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdir } from "../fixture/fixture"
import { createLocalCoordinator } from "@/workmesh/coordinator"
import { createRelayCoordinator } from "@/workmesh/relay-coordinator"
import { WorkMeshRuntimeLayout } from "@/workmesh/runtime-layout"

describe("WorkMesh remote relay coordinator", () => {
  test("moves a task and live events between independent project databases", async () => {
    await using senderProject = await tmpdir({ git: true })
    await using receiverProject = await tmpdir({ git: true })
    const relay = createRelayServer()
    const senderLayout = WorkMeshRuntimeLayout.layoutForRoot(senderProject.path)
    const receiverLayout = WorkMeshRuntimeLayout.layoutForRoot(receiverProject.path)
    await Promise.all([mkdir(senderLayout.data, { recursive: true }), mkdir(receiverLayout.data, { recursive: true })])
    const senderRuntime = ManagedRuntime.make(Database.layerFromPath(senderLayout.database))
    const receiverRuntime = ManagedRuntime.make(Database.layerFromPath(receiverLayout.database))
    try {
      const senderDB = (await senderRuntime.runPromise(Database.Service)).db
      const receiverDB = (await receiverRuntime.runPromise(Database.Service)).db
      const config = { baseUrl: relay.url, apiPrefix: "", projectId: 1, token: "test" }
      const sender = createRelayCoordinator(
        await createLocalCoordinator(senderProject.path, senderDB),
        senderDB,
        senderProject.path,
        config,
      )
      const receiver = createRelayCoordinator(
        await createLocalCoordinator(receiverProject.path, receiverDB),
        receiverDB,
        receiverProject.path,
        config,
      )
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
      await waitFor(() => relay.subscribers() === 2)
      expect((await sender.listAgents()).map((item) => item.terminalId).sort()).toEqual(["receiver", "sender"])

      const task = await sender.sendMessage({
        senderTerminalId: "sender",
        recipientTerminalId: "receiver",
        message: "/compose 检查远程任务",
        execution: { kind: "command", agent: "plan", name: "compose", arguments: "检查远程任务" },
      })
      await waitFor(async () => (await receiver.listMessages("receiver")).some((item) => item.id === task.id))
      expect((await receiver.listMessages("receiver"))[0]?.execution).toEqual({
        kind: "command",
        agent: "plan",
        name: "compose",
        arguments: "检查远程任务",
      })
      await receiver.claimMessage("receiver", task.id)
      await receiver.reportMessageEvent({
        terminalId: "receiver",
        messageId: task.id,
        sequence: 1,
        kind: "assistant.text",
        content: "正在执行",
      })
      await receiver.completeMessage("receiver", task.id, "执行完成")
      const reply = await receiver.sendMessage({
        senderTerminalId: "receiver",
        recipientTerminalId: "sender",
        replyToMessageId: task.id,
        message: "执行完成",
      })

      await waitFor(async () => (await sender.listConversation("sender", "receiver"))[0]?.status === "completed")
      await waitFor(async () =>
        (await sender.listConversation("sender", "receiver")).some((item) => item.id === reply.id),
      )
      expect((await sender.listMessageEvents("sender", "receiver")).items.map((item) => item.content)).toEqual([
        "正在执行",
      ])
      await Bun.sleep(500)
      expect(
        await Effect.runPromise(
          senderDB.all<{ delivery_id: string; envelope: string }>(
            "SELECT delivery_id, envelope FROM workmesh_terminal_outbox",
          ),
        ),
      ).toEqual([])

      await Promise.all([sender.release("sender"), receiver.release("receiver")])
    } finally {
      relay.stop()
      await Promise.all([senderRuntime.dispose(), receiverRuntime.dispose()])
    }
  }, 20_000)
})

function createRelayServer() {
  const terminals = new Map<string, Record<string, unknown>>()
  const subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const encoder = new TextEncoder()
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/workmesh/terminal/register") {
        const body = (await request.json()) as Record<string, unknown>
        terminals.set(String(body.terminalId), { ...body, lastSeenAt: new Date().toISOString() })
        return Response.json({ code: "OK", data: { item: body } })
      }
      if (url.pathname === "/workmesh/terminal/heartbeat") {
        return Response.json({ code: "OK", data: {} })
      }
      if (url.pathname === "/workmesh/terminal/index") {
        return Response.json({ code: "OK", data: { items: [...terminals.values()] } })
      }
      if (url.pathname === "/workmesh/terminal/relay/publish") {
        const event = await request.json()
        const chunk = encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        for (const subscriber of subscribers) subscriber.enqueue(chunk)
        return Response.json({ code: "OK", data: { subscriberCount: subscribers.size } })
      }
      if (url.pathname === "/workmesh/terminal/relay/stream") {
        let current: ReadableStreamDefaultController<Uint8Array> | undefined
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              current = controller
              subscribers.add(controller)
              controller.enqueue(encoder.encode(": connected\n\n"))
            },
            cancel() {
              if (current) subscribers.delete(current)
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        )
      }
      return new Response("not found", { status: 404 })
    },
  })
  return {
    url: server.url.origin,
    subscribers: () => subscribers.size,
    stop: () => server.stop(true),
  }
}

async function waitFor(check: () => boolean | Promise<boolean>) {
  const started = Date.now()
  while (Date.now() - started < 5_000) {
    if (await check()) return
    await Bun.sleep(25)
  }
  throw new Error("等待 Relay 状态超时")
}
