import { describe, expect, test } from "bun:test"
import { WorkMeshCommandLocale } from "@/workmesh/command-locale"

describe("WorkMesh command localization", () => {
  test("resolves explicit and automatic locales", () => {
    expect(WorkMeshCommandLocale.resolve("zh-CN", "en-US")).toBe("zh-CN")
    expect(WorkMeshCommandLocale.resolve("en-US", "zh-CN")).toBe("en-US")
    expect(WorkMeshCommandLocale.resolve("auto", "zh-CN")).toBe("zh-CN")
    expect(WorkMeshCommandLocale.resolve("auto", "en-US")).toBe("en-US")
  })

  test("localizes original commands and built-in skill commands", () => {
    expect(WorkMeshCommandLocale.description("review", undefined, "zh-CN")).toContain("审查")
    expect(WorkMeshCommandLocale.description("docx", undefined, "zh-CN")).toContain("Word 文档")
    expect(WorkMeshCommandLocale.description("docx", undefined, "en-US")).toContain("Word documents")
    expect(WorkMeshCommandLocale.description("terminals", undefined, "zh-CN")).toContain("可通信的终端")
    expect(WorkMeshCommandLocale.description("message", undefined, "zh-CN")).toContain("选择一个终端")
    expect(WorkMeshCommandLocale.description("messages", undefined, "en-US")).toContain("unread messages")
    expect(WorkMeshCommandLocale.description("external", "External description", "zh-CN")).toBe("External description")
  })
})
