import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "@/permission"
import { WorkMeshProduct } from "./product"

const agents = new Set(["compose", "compose-execute", "compose-review"])
const internalAgents = new Set(["compose-execute", "compose-review"])

export function isFamily(name: string) {
  return WorkMeshProduct.enabled && agents.has(name)
}

export function isInternal(name: string) {
  return WorkMeshProduct.enabled && internalAgents.has(name)
}

export function merge(agent: { name: string; permission: PermissionV1.Ruleset }, session: PermissionV1.Ruleset = []) {
  if (!isFamily(agent.name)) return Permission.merge(agent.permission, session)
  return Permission.merge(session, agent.permission)
}

export * as ComposePermission from "./compose-permission"
