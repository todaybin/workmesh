import * as Tool from "./tool"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { createWorkMeshCoordinator } from "@/workmesh/coordinator-service"
import { WorkMeshProduct } from "@/workmesh/product"

const Parameters = Schema.Struct({})
type Metadata = { count: number }

export const ListAgentsTool = Tool.define<typeof Parameters, Metadata, never>(
  "ListAgents",
  Effect.succeed({
    description:
      "发现当前项目中的其他 WorkMesh Agent，返回状态、任务和工作区摘要。只返回轻量元数据，不返回聊天历史或文件内容。",
    parameters: Parameters,
    execute: (_args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
      Effect.gen(function* () {
        if (!WorkMeshProduct.enabled)
          return { title: "", metadata: { count: 0 }, output: "ListAgents 仅在 WorkMesh 模式可用。" }
        const instance = yield* InstanceState.context
        const projectRoot = instance.worktree === "/" ? instance.directory : instance.worktree
        const coordinator = yield* Effect.promise(() => createWorkMeshCoordinator(projectRoot))
        const terminalId = `session:${ctx.sessionID}`
        yield* Effect.promise(() =>
          coordinator.register({
            terminalId,
            sessionId: ctx.sessionID,
            displayName: `WorkMesh ${String(ctx.sessionID).slice(-8)}`,
            role: ctx.agent,
            capabilities: ["message", "task"],
            status: "online",
            workspaceMode: "shared",
          }),
        )
        const agents = yield* Effect.promise(() => coordinator.listAgents())
        const others = agents.filter((agent) => agent.terminalId !== terminalId)
        return {
          title: "Agent 列表",
          metadata: { count: others.length },
          output: others.length
            ? others
                .map(
                  (agent) =>
                    `- ${agent.displayName} (${agent.terminalId})：${agent.status}，任务 ${agent.taskId || "无"}，工作区 ${agent.workspaceMode}`,
                )
                .join("\n")
            : "当前项目没有其他已注册 Agent。",
        }
      }),
  }),
)
