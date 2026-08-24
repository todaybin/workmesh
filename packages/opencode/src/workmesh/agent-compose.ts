import PROMPT_COMPOSE from "@/agent/prompt/compose.txt"
import { Permission } from "@/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Info } from "@/agent/agent"

// Compose agent 定义从 agent.ts 抽离到隔离岛，降低与上游 agent.ts 的合并冲突面。
// 上游 agent.ts 仅通过 createComposeAgents 注入，不再内联大段 WorkMesh 逻辑。

export interface ComposeAgentDeps {
  defaults: PermissionV1.Rule[]
  user: PermissionV1.Rule[]
  readonlyExternalDirectory: Record<string, "allow" | "ask" | "deny">
}

export function createComposeAgents(deps: ComposeAgentDeps): Record<string, Info> {
  const { defaults, user, readonlyExternalDirectory } = deps
  return {
    compose: {
      name: "compose",
      description:
        "Spec-driven WorkMesh orchestration with approval, isolated implementation, verification, and review.",
      prompt: PROMPT_COMPOSE,
      options: {},
      permission: Permission.merge(
        defaults,
        user,
        Permission.fromConfig({
          "*": "deny",
          question: "allow",
          read: "allow",
          glob: "allow",
          grep: "allow",
          list: "allow",
          skill: "allow",
          webfetch: "allow",
          websearch: "allow",
          external_directory: readonlyExternalDirectory,
          plan_enter: "deny",
          plan_exit: "deny",
        }),
      ),
      mode: "primary" as const,
      native: true,
    },
    "compose-execute": {
      name: "compose-execute",
      description: "Hidden WorkMesh Compose implementation and verification agent.",
      prompt: PROMPT_COMPOSE,
      options: {},
      permission: Permission.merge(
        defaults,
        user,
        Permission.fromConfig({
          "*": "deny",
          read: "allow",
          glob: "allow",
          grep: "allow",
          list: "allow",
          edit: "allow",
          write: "allow",
          apply_patch: "allow",
          lsp: "allow",
          question: "deny",
          task: "deny",
          external_directory: "deny",
          plan_enter: "deny",
          plan_exit: "deny",
          bash: "deny",
        }),
      ),
      mode: "primary" as const,
      native: true,
      hidden: true,
    },
    "compose-review": {
      name: "compose-review",
      description: "Hidden read-only WorkMesh Compose reviewer.",
      prompt: PROMPT_COMPOSE,
      options: {},
      permission: Permission.merge(
        defaults,
        user,
        Permission.fromConfig({
          "*": "deny",
          read: "allow",
          glob: "allow",
          grep: "allow",
          list: "allow",
          skill: "allow",
          webfetch: "allow",
          websearch: "allow",
          external_directory: readonlyExternalDirectory,
        }),
      ),
      mode: "primary" as const,
      native: true,
      hidden: true,
    },
  }
}
