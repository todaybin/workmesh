import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"
import PROMPT_PLAN_ZH_CN from "./prompt/plan.zh-CN.txt"
import BUILD_SWITCH_ZH_CN from "./prompt/build-switch.zh-CN.txt"
import PLAN_MODE_ZH_CN from "./prompt/plan-mode.zh-CN.txt"
import type { WorkMeshLanguage } from "@/workmesh/language"

export function copy(language: WorkMeshLanguage.ResolvedLanguage) {
  if (language === "zh-CN") {
    return {
      plan: PROMPT_PLAN_ZH_CN,
      buildSwitch: BUILD_SWITCH_ZH_CN,
      planMode: PLAN_MODE_ZH_CN,
      existingPlan: (plan: string) => `计划文件已存在于 ${plan}。你可以读取它，并使用编辑工具进行增量修改。`,
      missingPlan: (plan: string) => `计划文件尚不存在。你应使用写入工具在 ${plan} 创建计划。`,
      executePlan: (plan: string) => `计划文件位于 ${plan}。你应执行其中定义的计划。`,
    }
  }
  return {
    plan: PROMPT_PLAN,
    buildSwitch: BUILD_SWITCH,
    planMode: PLAN_MODE,
    existingPlan: (plan: string) =>
      `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.`,
    missingPlan: (plan: string) =>
      `No plan file exists yet. You should create your plan at ${plan} using the write tool.`,
    executePlan: (plan: string) => `A plan file exists at ${plan}. You should execute on the plan defined within it`,
  }
}

export * as SessionReminderLocale from "./reminder-locale"
