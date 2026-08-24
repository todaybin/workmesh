import { describe, expect, test } from "bun:test"
import { registerExternalTool } from "@/session/tools"

describe("Session tool registration", () => {
  test("does not let an external tool replace a reserved ID", () => {
    const builtin = { source: "builtin" }
    const tools: Record<string, { source: string }> = { apply_patch: builtin }

    expect(registerExternalTool(tools, "apply_patch", { source: "mcp" })).toBe(false)
    expect(tools.apply_patch).toBe(builtin)
    expect(registerExternalTool(tools, "server_search", { source: "mcp" })).toBe(true)
    expect(tools.server_search).toEqual({ source: "mcp" })
  })
})
