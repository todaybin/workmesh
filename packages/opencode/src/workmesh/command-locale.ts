import type { WorkMeshLanguage } from "./language"

export type DisplayLocale = "zh-CN" | "en-US"

type LocalizedDescription = Record<DisplayLocale, string>

const descriptions: Record<string, LocalizedDescription> = {
  init: {
    "zh-CN": "引导创建或更新项目 AGENTS.md 规则",
    "en-US": "Guided AGENTS.md project setup",
  },
  review: {
    "zh-CN": "审查未提交、提交、分支或 PR 的代码变更",
    "en-US": "Review uncommitted, commit, branch, or PR changes",
  },
  goal: {
    "zh-CN": "设置停止条件并持续执行，使用 /goal clear 取消",
    "en-US": "Run until a stop condition passes; use /goal clear to cancel",
  },
  loop: {
    "zh-CN": "按周期持续执行任务：/loop [60-3600秒] <任务>",
    "en-US": "Run a task periodically: /loop [60-3600s] <task>",
  },
  loops: {
    "zh-CN": "查看循环任务；使用 /loops <ID前缀> 取消",
    "en-US": "List loop jobs; use /loops <ID prefix> to cancel",
  },
  language: {
    "zh-CN": "选择界面与回复语言：中文、英文或自动",
    "en-US": "Choose the interface and response language: Chinese, English, or auto",
  },
  lang: {
    "zh-CN": "选择界面与回复语言（/language 的简写）",
    "en-US": "Choose the interface and response language (alias of /language)",
  },
  terminals: {
    "zh-CN": "查看当前项目中可通信的终端",
    "en-US": "List terminals available for messaging in the current project",
  },
  message: {
    "zh-CN": "选择一个终端并发送短消息",
    "en-US": "Select a terminal and send a short message",
  },
  messages: {
    "zh-CN": "查看当前终端收到的未读消息",
    "en-US": "Read unread messages received by the current terminal",
  },
  compose: {
    "zh-CN": "启动或管理可恢复的 Compose 自动工作流",
    "en-US": "Start or manage a resumable Compose workflow",
  },
  "compose-next": {
    "zh-CN": "通过规格、隔离实现、验证和审查完成复杂任务",
    "en-US": "Complete complex work through specification, isolation, verification, and review",
  },
  arxiv: {
    "zh-CN": "论文检索：检索、读取、引用或下载 arXiv 论文",
    "en-US": "Paper research: search, read, cite, or download arXiv papers",
  },
  "deep-research": {
    "zh-CN": "深度研究：执行多来源、可追溯的调查并生成统一报告",
    "en-US": "Deep research: investigate multiple sources and produce a cited report",
  },
  docx: {
    "zh-CN": "Word 文档：读取、生成、编辑、转换或校验 DOCX",
    "en-US": "Word documents: read, create, edit, convert, or validate DOCX files",
  },
  "frontend-design": {
    "zh-CN": "前端 UI 设计：生成、修改、审查或交付 Design IR",
    "en-US": "Frontend UI design: create, edit, review, or deliver Design IR",
  },
  "general-work-assistant": {
    "zh-CN": "通用办公助手：规划、审查产物并拆解跨场景工作流",
    "en-US": "General work assistant: plan, review artifacts, and decompose workflows",
  },
  "modern-python-toolchain": {
    "zh-CN": "现代 Python 工具链：使用 uv、Ruff 和 Pyright 维护项目",
    "en-US": "Modern Python toolchain: maintain projects with uv, Ruff, and Pyright",
  },
  pdf: {
    "zh-CN": "PDF 文档：检查、合并、转换、渲染或校验 PDF",
    "en-US": "PDF documents: inspect, merge, convert, render, or validate PDFs",
  },
  pptx: {
    "zh-CN": "演示文稿：读取、生成、编辑、转换或校验 PPTX",
    "en-US": "Presentations: read, create, edit, convert, or validate PPTX files",
  },
  "skill-creator": {
    "zh-CN": "技能创建：创建、审查或改进 WorkMesh Skill 包",
    "en-US": "Skill creator: create, review, or improve WorkMesh Skill packages",
  },
  "workmesh-docs": {
    "zh-CN": "WorkMesh 文档：查询命令、配置、运行目录和能力接入说明",
    "en-US": "WorkMesh docs: find commands, configuration, runtime, and integration guidance",
  },
  xlsx: {
    "zh-CN": "电子表格：读取、生成、编辑、分析或校验 XLSX",
    "en-US": "Spreadsheets: read, create, edit, analyze, or validate XLSX workbooks",
  },
  "customize-opencode": {
    "zh-CN": "配置 OpenCode：修改配置、Agent、Skill、Plugin、MCP 或权限规则",
    "en-US": "Configure OpenCode settings, agents, skills, plugins, MCP servers, or permissions",
  },
}

export function resolve(
  language: WorkMeshLanguage.Language,
  systemLocale = Intl.DateTimeFormat().resolvedOptions().locale,
) {
  if (language === "zh-CN" || language === "en-US") return language
  return systemLocale.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US"
}

export function description(name: string, fallback: string | undefined, locale: DisplayLocale) {
  return descriptions[name]?.[locale] ?? fallback
}

export * as WorkMeshCommandLocale from "./command-locale"
