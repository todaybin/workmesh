import * as Tool from "./tool"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { createWorkMeshCoordinator } from "@/workmesh/coordinator-service"
import { WorkMeshProduct } from "@/workmesh/product"

const Parameters = Schema.Struct({
  recipientTerminalId: Schema.String.annotate({ description: "接收消息的 Agent 终端 ID" }),
  message: Schema.String.annotate({ description: "仅发送简短文本摘要，最大 8 KiB，不要粘贴文件或完整上下文" }),
  replyToMessageId: Schema.optional(Schema.String),
  idempotencyKey: Schema.optional(Schema.String),
})
type Metadata = { messageId: string; status: string }

export const SendMessageTool = Tool.define<typeof Parameters, Metadata, never>(
  "SendMessage",
  Effect.succeed({
    description: "向另一个 WorkMesh Agent 投递异步短文本消息。消息不会打断对方正在运行的命令、编译或测试。",
    parameters: Parameters,
    execute: (args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
      Effect.gen(function* () {
        if (!WorkMeshProduct.enabled)
          return {
            title: "",
            metadata: { messageId: "", status: "disabled" },
            output: "SendMessage 仅在 WorkMesh 模式可用。",
          }
        const instance = yield* InstanceState.context
        const projectRoot = instance.worktree === "/" ? instance.directory : instance.worktree
        const coordinator = yield* Effect.promise(() => createWorkMeshCoordinator(projectRoot))
        const sender = `session:${ctx.sessionID}`
        yield* Effect.promise(() =>
          coordinator.register({
            terminalId: sender,
            sessionId: ctx.sessionID,
            displayName: `WorkMesh ${String(ctx.sessionID).slice(-8)}`,
            role: ctx.agent,
            capabilities: ["message", "task"],
            status: "online",
            workspaceMode: "shared",
          }),
        )
        const message = yield* Effect.promise(() =>
          coordinator.sendMessage({
            senderTerminalId: sender,
            recipientTerminalId: args.recipientTerminalId,
            message: args.message,
            replyToMessageId: args.replyToMessageId,
            idempotencyKey: args.idempotencyKey,
          }),
        )
        return {
          title: "消息已排队",
          metadata: { messageId: message.id, status: message.status },
          output: `消息已投递到队列：${message.id}`,
        }
      }),
  }),
)
