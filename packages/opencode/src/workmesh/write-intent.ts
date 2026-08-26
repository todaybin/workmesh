import { Effect } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type * as Tool from "@/tool/tool"
import { WorkMeshProduct } from "./product"
import { createWorkMeshCoordinator } from "./coordinator-service"

export type WriteIntentLease = {
  release: () => Promise<void>
}

/**
 * 在真正写入前登记文件/目录写意图。WorkMesh 之外返回空租约，保持官方 OpenCode 行为不变。
 */
export function acquireWriteIntent(
  instance: InstanceContext,
  ctx: Tool.Context,
  paths: string[],
): Effect.Effect<WriteIntentLease> {
  if (!WorkMeshProduct.enabled || paths.length === 0) return Effect.succeed({ release: async () => undefined })

  return Effect.gen(function* () {
    const projectRoot = instance.worktree === "/" ? instance.directory : instance.worktree
    const coordinator = yield* Effect.promise(() => createWorkMeshCoordinator(projectRoot))
    const terminalId = `session:${ctx.sessionID}`
    yield* Effect.promise(() =>
      coordinator.register({
        terminalId,
        sessionId: ctx.sessionID,
        displayName: `WorkMesh ${String(ctx.sessionID).slice(-8)}`,
        role: ctx.agent,
        capabilities: ["message", "task", "write-intent"],
        status: "busy",
        workspaceMode: "shared",
      }),
    )
    const intent = yield* Effect.promise(() =>
      coordinator.claimIntent({
        terminalId,
        paths,
        mode: "write",
        workspaceMode: "shared",
      }),
    )
    if (intent.status === "conflict") {
      return yield* Effect.die(new Error(`WorkMesh 写入冲突：${paths.join(", ")} 已被其他 Agent 占用`))
    }
    let released = false
    return {
      release: async () => {
        if (released) return
        released = true
        await coordinator.releaseIntent(terminalId, intent.id).catch(() => undefined)
      },
    }
  })
}

export function releaseWriteIntent(lease: WriteIntentLease): Effect.Effect<void> {
  return Effect.promise(() => lease.release())
}

export function withWriteIntent<E, R>(
  instance: InstanceContext,
  ctx: Tool.Context,
  paths: string[],
  use: Effect.Effect<void, E, R>,
): Effect.Effect<void, E, R> {
  if (!WorkMeshProduct.enabled || paths.length === 0) return use
  return Effect.acquireUseRelease(acquireWriteIntent(instance, ctx, paths), () => use, releaseWriteIntent)
}
