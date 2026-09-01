import { createEffect, createSignal, onCleanup } from "solid-js"
import { createSimpleContext } from "../context/helper"
import { useEvent } from "../context/event"
import { useProject } from "../context/project"
import { useSync } from "../context/sync"
import { commandLocale, type WorkMeshLocale } from "./command-locale"
import { TuiProduct } from "../product"

const messages = {
  en: {
    agents: "agents",
    commands: "commands",
    exitShellMode: "exit shell mode",
    selectLanguage: "Select language",
    chinese: "Simplified Chinese",
    english: "English",
    automatic: "Auto",
    chineseDescription: "Chinese interface and responses",
    englishDescription: "English interface and responses",
    automaticDescription: "Follow the system language",
    languageUpdateFailed: "Failed to change language",
    thinking: "Thinking",
    thought: "Thought",
    subagent: "Subagent",
    parent: "Parent",
    previous: "Prev",
    next: "Next",
    viewSubagents: "view subagents",
    background: "background",
    task: "Task",
    delegating: "Delegating...",
    retryError: "Retry Error",
    retrying: "Retrying",
    attempt: "attempt",
    toolcall: "toolcall",
    toolcalls: "toolcalls",
    composeApprovalTitle: "Approve Compose specification",
    composeApprovalDescription: "Review the specification before implementation starts.",
    composeApprove: "Approve and implement",
    composeApproveWorking: "Include current changes",
    composeApproveWorkingDescription: "Copy current uncommitted changes into an isolated serial workspace",
    composeApproveHead: "Start from HEAD",
    composeApproveHeadDescription: "Use a clean isolated workspace and exclude current uncommitted changes",
    composeRevise: "Request changes",
    composeCancel: "Cancel run",
    composeRevisionTitle: "Compose revision request",
    composeRevisionPlaceholder: "Describe the required changes",
    composeFinishTitle: "Finish Compose run",
    composeFinishDescription: "Choose the Git action. No changes are made until you confirm.",
    composeMerge: "Merge locally",
    composePr: "Create pull request",
    composePush: "Push only",
    composeKeep: "Keep branch",
    composeDiscard: "Discard",
    composeDiscardTitle: "Discard Compose work?",
    composeDiscardMessage: "The Compose worktree and its branch will be removed.",
    composeCommandFailed: "Compose action failed",
    composeStage: "Compose",
    composeTasks: "tasks",
    composeBranch: "Branch",
    composeBase: "Base",
    composeHead: "HEAD",
    composeWorktree: "Worktree",
    composeSpec: "Specification",
    worktreeTitle: "Worktree",
    moveSessionTitle: "Move session",
    worktreeLoading: "Loading project directories...",
    worktreeCreate: "Create new Worktree",
    worktreeCreateDescription: "Create an isolated Git working tree",
    worktreeCategoryCreate: "Create",
    worktreeCategoryCurrent: "Current",
    worktreeCategoryMain: "Main",
    worktreeCategoryOther: "Other",
    worktreeDeleting: "Deleting {directory}",
    worktreeConfirmDelete: "Press {shortcut} again to confirm",
    worktreeDeleteTitle: "Delete working copy?",
    worktreeDeleteMessage: "This working copy has file changes. Do you want to delete it anyway?",
    worktreeDeleteFailed: "Failed to delete project copy",
    worktreeLoadFailed: "Could not load project directories",
    worktreeActionNew: "new",
    worktreeActionDelete: "delete",
    worktreeActionRefresh: "refresh",
    worktreeChangesTitle: "File changes found",
    worktreeChangesMessage: "Do you want to move these changes with the session?",
    worktreeChoiceNo: "no",
    worktreeChoiceYes: "yes",
    worktreeCreating: "Creating Worktree",
    worktreeCreatingSession: "Creating session",
    worktreeCreateFailed: "Creating Worktree failed",
    worktreeCreateMissingDirectory: "The server did not return the new Worktree directory",
    worktreeMovingSession: "Moving session",
    worktreeSubmittingPrompt: "Submitting prompt",
    messageSelectTerminalTitle: "Send message",
    messageCommandDescription: "Select an online terminal and send a message",
    messageSelectTerminalPlaceholder: "Search terminals",
    messageLoadingTerminals: "Loading terminals...",
    messageNoTerminals: "No other online terminals are available.",
    messageComposeTitle: "Message",
    messageComposePlaceholder: "Enter a short message",
    messageComposeDescription: "Press Enter to send. Escape cancels.",
    messageSentTitle: "Message sent",
    messageSent: "The message was queued for delivery.",
    messageSendFailed: "Message failed",
    messageNoSession: "Open a session before sending a message.",
    messageTerminalOnline: "online",
    messageTerminalBusy: "busy",
    messageTerminalAway: "away",
  },
  "zh-CN": {
    agents: "Agent",
    commands: "命令",
    exitShellMode: "退出 Shell 模式",
    selectLanguage: "选择语言",
    chinese: "简体中文",
    english: "English",
    automatic: "自动",
    chineseDescription: "界面和回复使用中文",
    englishDescription: "界面和回复使用英文",
    automaticDescription: "跟随系统语言",
    languageUpdateFailed: "切换语言失败",
    thinking: "思考中",
    thought: "思考",
    subagent: "子 Agent",
    parent: "父会话",
    previous: "上一个",
    next: "下一个",
    viewSubagents: "查看子 Agent",
    background: "后台",
    task: "任务",
    delegating: "正在委派...",
    retryError: "重试错误",
    retrying: "正在重试",
    attempt: "第 {attempt} 次",
    toolcall: "次工具调用",
    toolcalls: "次工具调用",
    composeApprovalTitle: "批准 Compose 规格",
    composeApprovalDescription: "请在开始实现前审阅规格。",
    composeApprove: "批准并实现",
    composeApproveWorking: "包含当前改动",
    composeApproveWorkingDescription: "把当前未提交改动复制到隔离工作区，并以串行方式实现",
    composeApproveHead: "从 HEAD 开始",
    composeApproveHeadDescription: "使用干净隔离工作区，不包含当前未提交改动",
    composeRevise: "要求修改",
    composeCancel: "取消运行",
    composeRevisionTitle: "Compose 修改要求",
    composeRevisionPlaceholder: "说明需要修改的内容",
    composeFinishTitle: "完成 Compose 运行",
    composeFinishDescription: "请选择 Git 收尾操作，确认前不会执行任何变更。",
    composeMerge: "本地合并",
    composePr: "创建 PR",
    composePush: "仅推送",
    composeKeep: "保留分支",
    composeDiscard: "放弃",
    composeDiscardTitle: "确认放弃 Compose 工作？",
    composeDiscardMessage: "将删除本次 Compose 的 Worktree 和专属分支。",
    composeCommandFailed: "Compose 操作失败",
    composeStage: "Compose",
    composeTasks: "任务",
    composeBranch: "分支",
    composeBase: "基准",
    composeHead: "HEAD",
    composeWorktree: "Worktree",
    composeSpec: "规格",
    worktreeTitle: "工作树",
    moveSessionTitle: "移动会话",
    worktreeLoading: "正在加载项目目录...",
    worktreeCreate: "创建新工作树",
    worktreeCreateDescription: "创建隔离的 Git 工作树",
    worktreeCategoryCreate: "创建",
    worktreeCategoryCurrent: "当前",
    worktreeCategoryMain: "主空间",
    worktreeCategoryOther: "其他",
    worktreeDeleting: "正在删除 {directory}",
    worktreeConfirmDelete: "再次按 {shortcut} 确认删除",
    worktreeDeleteTitle: "删除工作树？",
    worktreeDeleteMessage: "此工作树包含文件改动，仍要删除吗？",
    worktreeDeleteFailed: "删除工作树失败",
    worktreeLoadFailed: "无法加载项目目录",
    worktreeActionNew: "新建",
    worktreeActionDelete: "删除",
    worktreeActionRefresh: "刷新",
    worktreeChangesTitle: "发现文件改动",
    worktreeChangesMessage: "是否将这些改动随会话一起移动？",
    worktreeChoiceNo: "否",
    worktreeChoiceYes: "是",
    worktreeCreating: "正在创建工作树",
    worktreeCreatingSession: "正在创建会话",
    worktreeCreateFailed: "创建工作树失败",
    worktreeCreateMissingDirectory: "服务端未返回新工作树目录",
    worktreeMovingSession: "正在移动会话",
    worktreeSubmittingPrompt: "正在提交提示词",
    messageSelectTerminalTitle: "发送消息",
    messageCommandDescription: "选择在线终端并发送消息",
    messageSelectTerminalPlaceholder: "搜索终端",
    messageLoadingTerminals: "正在加载终端...",
    messageNoTerminals: "当前没有其他在线终端。",
    messageComposeTitle: "发送消息",
    messageComposePlaceholder: "输入简短消息",
    messageComposeDescription: "按回车发送，按 Esc 取消。",
    messageSentTitle: "消息已发送",
    messageSent: "消息已进入发送队列。",
    messageSendFailed: "消息发送失败",
    messageNoSession: "请先进入一个会话，再发送消息。",
    messageTerminalOnline: "在线",
    messageTerminalBusy: "忙碌",
    messageTerminalAway: "暂离",
  },
} as const

export type WorkMeshMessageKey = keyof (typeof messages)["en"]

export function translate(locale: WorkMeshLocale, key: WorkMeshMessageKey, values?: Record<string, string | number>) {
  let value: string = messages[locale][key]
  for (const [name, replacement] of Object.entries(values ?? {})) {
    value = value.replaceAll(`{${name}}`, String(replacement))
  }
  return value
}

function eventLocale(event: unknown): WorkMeshLocale | undefined {
  if (!event || typeof event !== "object") return
  const candidate = event as { type?: unknown; properties?: Record<string, unknown> }
  if (candidate.type !== "workmesh.language.changed") return
  const properties = candidate.properties
  const value = properties?.resolvedLanguage ?? properties?.locale ?? properties?.language
  if (value === "zh-CN" || value === "zh") return "zh-CN"
  if (value === "en" || value === "en-US") return "en"
}

export const { use: useWorkMeshLocale, provider: WorkMeshLocaleProvider } = createSimpleContext({
  name: "WorkMeshLocale",
  init: () => {
    const sync = useSync()
    const project = useProject()
    const event = useEvent()
    const [locale, setLocale] = createSignal<WorkMeshLocale>(
      TuiProduct.enabled ? commandLocale(sync.data.command) : "en",
    )

    createEffect(() => {
      if (!TuiProduct.enabled) return
      setLocale(commandLocale(sync.data.command))
    })

    const unsubscribe = event.subscribe((payload, metadata) => {
      if (!TuiProduct.enabled) return
      if (metadata.workspace !== project.workspace.current()) return
      const next = eventLocale(payload)
      if (next) setLocale(next)
    })
    onCleanup(unsubscribe)

    return {
      locale,
      setLocale,
      isChinese: () => locale() === "zh-CN",
      t: (key: WorkMeshMessageKey, values?: Record<string, string | number>) => translate(locale(), key, values),
    }
  },
})
