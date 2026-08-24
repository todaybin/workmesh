import path from "node:path"
import { WorkMeshRuntimeLayout } from "./runtime-layout"

export const configLoadNames = ["opencode.json", "opencode.jsonc", "workmesh.json", "workmesh.jsonc"] as const
export const configWriteNames = ["workmesh.jsonc", "workmesh.json", "opencode.jsonc", "opencode.json"] as const

export function directory(projectRoot: string) {
  return WorkMeshRuntimeLayout.layoutForRoot(projectRoot).config
}

export function plans(projectRoot: string) {
  return path.join(WorkMeshRuntimeLayout.layoutForRoot(projectRoot).state, "plans")
}

// WorkMesh 模式保留旧目录但不再读取或改写其中的配置。
export function isLegacyPath(value: string) {
  return path
    .resolve(value)
    .split(path.sep)
    .some((segment) => segment.toLowerCase() === ".opencode")
}

export function adaptInstructions(content: string) {
  return content
    .replaceAll("~/.config/opencode", ".workmesh/config")
    .replaceAll(".opencode/", ".workmesh/config/")
    .replaceAll(".opencode", ".workmesh/config")
    .replaceAll("opencode.jsonc", "workmesh.jsonc")
    .replaceAll("opencode.json", "workmesh.json")
}

export * as WorkMeshCustomization from "./customization"
