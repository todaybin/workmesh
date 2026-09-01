export type WorkMeshLocale = "zh-CN" | "en"

type CommandLike = {
  name: string
  description?: string
}

const zhDescriptions: Record<string, string> = {
  editor: "在外部编辑器中编辑当前输入",
  skills: "查看并选择可用技能",
  warp: "切换当前会话的工作区",
  move: "将会话移动到其他项目目录",
  sessions: "切换或恢复会话",
  new: "新建会话",
  workspaces: "管理工作区",
  models: "切换模型",
  agents: "切换 Agent",
  mcps: "查看和切换 MCP Server",
  variants: "切换模型变体",
  connect: "连接模型提供商",
  org: "切换组织",
  status: "查看运行状态",
  debug: "查看调试信息",
  themes: "切换终端主题",
  help: "查看帮助",
  exit: "退出 WorkMesh",
  share: "共享当前会话或复制共享链接",
  rename: "重命名当前会话",
  timeline: "跳转到指定消息",
  fork: "从指定消息创建会话分支",
  compact: "压缩当前会话上下文",
  unshare: "取消共享当前会话",
  undo: "撤销上一条消息及其文件改动",
  redo: "恢复已撤销的消息及文件改动",
  timestamps: "显示或隐藏消息时间",
  thinking: "展开或收起思考内容",
  copy: "复制会话记录",
  export: "导出会话记录",
}

export function commandLocale(commands: readonly CommandLike[]): WorkMeshLocale {
  const language = commands.find((command) => command.name === "language")
  if (!language) return systemLocale()
  return language.description?.includes("语言") ? "zh-CN" : "en"
}

export function systemLocale(language = Intl.DateTimeFormat().resolvedOptions().locale): WorkMeshLocale {
  return language.toLowerCase().startsWith("zh") ? "zh-CN" : "en"
}

export function localizeSlashDescription(name: string, description: string | undefined, locale: WorkMeshLocale) {
  if (locale !== "zh-CN") return description
  return zhDescriptions[name] ?? description
}
