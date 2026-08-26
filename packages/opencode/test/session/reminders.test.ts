import { Effect } from "effect"
import { expect } from "bun:test"
import { SessionReminderLocale } from "@/session/reminder-locale"
import { it } from "../lib/effect"

it.effect("localizes plan reminders without changing technical paths", () =>
  Effect.sync(() => {
    const chinese = SessionReminderLocale.copy("zh-CN")
    const english = SessionReminderLocale.copy("en-US")
    const plan = String.raw`E:\dev\project\.workmesh\plans\session.md`

    expect(chinese.plan).toContain("计划模式 - 系统提醒")
    expect(chinese.buildSwitch).toContain("从计划切换为构建")
    expect(chinese.existingPlan(plan)).toContain(plan)
    expect(chinese.missingPlan(plan)).toContain("计划文件尚不存在")
    expect(chinese.executePlan(plan)).toContain(plan)

    expect(english.plan).toContain("Plan Mode - System Reminder")
    expect(english.buildSwitch).toContain("plan to build")
    expect(english.existingPlan(plan)).toContain(plan)
  }),
)
