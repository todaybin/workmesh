import path from "node:path"
import { existsSync } from "node:fs"

export function directories(input: { executable: string; configured?: string; directory: string }) {
  const values = [
    input.configured ? path.resolve(input.directory, input.configured) : undefined,
    findNearest(path.dirname(input.executable)),
  ]
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

function findNearest(start: string) {
  for (let current = path.resolve(start); ; current = path.dirname(current)) {
    const candidate = path.join(current, "builtin", "skills")
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(current)
    if (parent === current) return
  }
}

export * as WorkMeshBuiltinSkills from "./builtin-skills"
