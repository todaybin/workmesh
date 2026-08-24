import { describe, expect, test } from "bun:test"
import { commandLocale, localizeSlashDescription, systemLocale } from "../../src/workmesh/command-locale"
import { translate } from "../../src/workmesh/locale"

describe("WorkMesh command locale", () => {
  test("detects the project locale from the language command", () => {
    expect(commandLocale([{ name: "language", description: "切换界面语言" }])).toBe("zh-CN")
    expect(commandLocale([{ name: "language", description: "Switch interface language" }])).toBe("en")
  })

  test("localizes built-in slash descriptions without changing command names", () => {
    expect(localizeSlashDescription("models", "Switch model", "zh-CN")).toBe("切换模型")
    expect(localizeSlashDescription("models", "Switch model", "en")).toBe("Switch model")
    expect(localizeSlashDescription("custom", "Custom command", "zh-CN")).toBe("Custom command")
  })

  test("resolves automatic language from the system locale", () => {
    expect(systemLocale("zh-CN")).toBe("zh-CN")
    expect(systemLocale("zh-Hans-SG")).toBe("zh-CN")
    expect(systemLocale("en-US")).toBe("en")
  })

  test("translates fixed TUI labels", () => {
    expect(translate("zh-CN", "thinking")).toBe("思考中")
    expect(translate("zh-CN", "commands")).toBe("命令")
    expect(translate("en", "thinking")).toBe("Thinking")
  })

  test("translates Worktree prompts without changing command semantics", () => {
    expect(translate("zh-CN", "worktreeTitle")).toBe("工作树")
    expect(translate("zh-CN", "worktreeCategoryMain")).toBe("主空间")
    expect(translate("zh-CN", "worktreeConfirmDelete", { shortcut: "ctrl+d" })).toBe("再次按 ctrl+d 确认删除")
    expect(translate("zh-CN", "worktreeMovingSession")).toBe("正在移动会话")
    expect(translate("en", "worktreeCategoryMain")).toBe("Main")
    expect(translate("en", "worktreeChoiceYes")).toBe("yes")
  })
})
