import { MouseEvent, TextareaRenderable, TextAttributes, type KeyEvent } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { useWorkMeshLocale } from "../workmesh/locale"
import { errorMessage } from "../util/error"
import { useBindings, useCommandShortcut } from "../keymap"
import { useTuiConfig } from "../config"
import { useSync } from "../context/sync"
import { useKV } from "../context/kv"
import type { TuiWorkmeshEventsResponse } from "@opencode-ai/sdk/v2"

export function DialogWorkMeshMessage(props: {
  sessionID: string
  /** 已知对端时直接打开会话，未提供时才显示终端选择器。 */
  targetTerminalId?: string
  targetTitle?: string
  currentTerminalId?: string
}) {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const locale = useWorkMeshLocale()
  const [terminals] = createResource(
    () => props.sessionID,
    async (sessionID) => (await sdk.client.tui.workmesh.terminals({ sessionID }, { throwOnError: true })).data,
  )
  const options = createMemo(() =>
    (terminals()?.items ?? [])
      .filter((item) => !item.current && item.status !== "offline")
      .map((item) => ({
        value: item.terminalId,
        title: item.displayName,
        description:
          item.status === "busy"
            ? locale.t("messageTerminalBusy")
            : item.status === "away"
              ? locale.t("messageTerminalAway")
              : locale.t("messageTerminalOnline"),
        details: [item.terminalId],
      })),
  )

  async function selectTerminal(terminalId: string) {
    // 等待选择项的 mouseup/keydown 事件完成后再切换输入框，避免旧的筛选输入夺走焦点。
    setTimeout(() => {
      dialog.replace(() => (
        <DialogWorkMeshConversation
          sessionID={props.sessionID}
          terminalId={terminalId}
          currentTerminalId={terminals()?.currentTerminalId}
          title={options().find((item) => item.value === terminalId)?.title ?? terminalId}
        />
      ))
    }, 0)
  }

  return (
    <Show
      when={props.targetTerminalId}
      fallback={
        <DialogSelect
          title={locale.t("messageSelectTerminalTitle")}
          placeholder={locale.t("messageSelectTerminalPlaceholder")}
          options={options()}
          locked={terminals.loading}
          emptyView={
            <Show when={!terminals.loading} fallback={<text fg="gray">{locale.t("messageLoadingTerminals")}</text>}>
              <text fg="gray">{terminals.error ? errorMessage(terminals.error) : locale.t("messageNoTerminals")}</text>
            </Show>
          }
          onSelect={(option) => void selectTerminal(option.value)}
        />
      }
    >
      {(terminalId) => (
        <DialogWorkMeshConversation
          sessionID={props.sessionID}
          terminalId={terminalId()}
          currentTerminalId={props.currentTerminalId ?? terminals()?.currentTerminalId}
          title={props.targetTitle ?? terminalId()}
        />
      )}
    </Show>
  )
}

function DialogWorkMeshConversation(props: {
  sessionID: string
  terminalId: string
  currentTerminalId?: string
  title: string
}) {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const locale = useWorkMeshLocale()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const dimensions = useTerminalDimensions()
  const sync = useSync()
  const kv = useKV()
  const submitShortcut = useCommandShortcut("dialog.prompt.submit")
  const [sending, setSending] = createSignal(false)
  const storedAgent = kv.get("workmesh_message_agent", "build")
  const [agent, setAgent] = createSignal<"build" | "plan">(storedAgent === "plan" ? "plan" : "build")
  const [liveReplies, setLiveReplies] = createSignal<Record<string, string>>({})
  const [draft, setDraft] = createSignal("")
  const [commandIndex, setCommandIndex] = createSignal(0)
  const [textareaTarget, setTextareaTarget] = createSignal<TextareaRenderable>()
  let textarea: TextareaRenderable
  const localTerminalId = () => props.currentTerminalId ?? `session:${props.sessionID}`
  const [messages, { refetch }] = createResource(
    () => ({ sessionID: props.sessionID, peerTerminalId: props.terminalId }),
    async (input) => (await sdk.client.tui.workmesh.messages(input, { throwOnError: true })).data,
  )
  let dragOrigin: { x: number; y: number; offsetX: number; offsetY: number } | undefined

  const commandOptions = createMemo(() => {
    const match = draft().match(/^\/([^\s]*)$/)
    if (!match) return []
    const query = match[1].toLowerCase()
    return sync.data.command
      .map((command) => ({
        display: `/${command.name}`,
        description: command.description,
      }))
      .filter((command) => command.display.slice(1).toLowerCase().includes(query))
      .sort((a, b) => {
        const aStarts = a.display.slice(1).toLowerCase().startsWith(query)
        const bStarts = b.display.slice(1).toLowerCase().startsWith(query)
        if (aStarts !== bStarts) return aStarts ? -1 : 1
        return a.display.localeCompare(b.display)
      })
      .slice(0, 10)
  })

  createEffect(() => {
    draft()
    setCommandIndex(0)
  })

  function setComposer(value: string) {
    textarea.setText(value)
    setDraft(value)
    textarea.focus()
    textarea.gotoLineEnd()
  }

  function selectCommand() {
    const command = commandOptions()[commandIndex()]
    if (!command) return false
    setComposer(`${command.display} `)
    return true
  }

  function moveCommand(direction: -1 | 1) {
    const count = commandOptions().length
    if (!count) return
    setCommandIndex((current) => (current + direction + count) % count)
  }

  function toggleAgent() {
    selectAgent(agent() === "build" ? "plan" : "build")
    setCommandIndex(0)
  }

  function selectAgent(value: "build" | "plan") {
    setAgent(value)
    kv.set("workmesh_message_agent", value)
  }

  // 过程事件和消息状态都来自本地 SQLite：短轮询读取增量事件，低频轮询校正最终状态。
  onMount(() => {
    let cursor = 0
    let polling = false
    const pollEvents = async () => {
      if (polling) return
      polling = true
      try {
        const result = await sdk.client.tui.workmesh.events(
          { sessionID: props.sessionID, peerTerminalId: props.terminalId, after: String(cursor), limit: "200" },
          { throwOnError: true },
        )
        cursor = Number(result.data.nextCursor)
        if (result.data.items.length === 0) return
        setLiveReplies((current) => {
          const next = { ...current }
          for (const item of result.data.items) {
            if (item.kind === "assistant.text") {
              next[item.messageId] = (next[item.messageId] ?? "") + item.content
              continue
            }
            if (item.kind === "task.completed" || item.kind === "task.failed") {
              delete next[item.messageId]
              continue
            }
            if (item.content) {
              const tool = typeof item.metadata.tool === "string" ? ` ${item.metadata.tool}` : ""
              const label = workMeshEventLabel(item.kind)
              next[item.messageId] = [next[item.messageId], `[${label}${tool}]`, item.content]
                .filter(Boolean)
                .join("\n")
            }
          }
          return next
        })
      } catch {
        // 下一轮仍从上次成功 cursor 继续，本地事件不会因一次读取失败而跳过。
      } finally {
        polling = false
      }
    }
    void pollEvents()
    const eventTimer = setInterval(() => void pollEvents(), 400)
    const statusTimer = setInterval(() => void refetch(), 1_000)
    onCleanup(() => clearInterval(eventTimer))
    onCleanup(() => clearInterval(statusTimer))
  })

  async function send() {
    if (sending()) return
    const message = textarea?.plainText?.trim() ?? ""
    if (!message) return
    const command = message.match(/^\/(\S+)(?:\s+([\s\S]*))?$/)
    if (command && !sync.data.command.some((item) => item.name === command[1])) {
      toast.show({ title: locale.t("messageSendFailed"), message: `远程终端不支持 /${command[1]} 命令。`, variant: "error" })
      return
    }
    setSending(true)
    try {
      await sdk.client.tui.workmesh.message(
        {
          sessionID: props.sessionID,
          recipientTerminalId: props.terminalId,
          message,
          execution: command
            ? { kind: "command", agent: agent(), name: command[1], arguments: command[2] ?? "" }
            : { kind: "prompt", agent: agent() },
        },
        { throwOnError: true },
      )
      toast.show({ title: locale.t("messageSentTitle"), message: locale.t("messageSent"), variant: "success" })
      setComposer("")
      await refetch()
    } catch (error) {
      toast.show({ title: locale.t("messageSendFailed"), message: errorMessage(error), variant: "error" })
    } finally {
      setSending(false)
      setTimeout(() => {
        if (!textarea || textarea.isDestroyed) return
        textarea.focus()
        textarea.gotoLineEnd()
      }, 1)
    }
  }

  useBindings(() => ({
    target: textareaTarget,
    enabled: textareaTarget() !== undefined && !sending(),
    priority: 1,
    commands: [
      {
        name: "dialog.prompt.submit",
        title: "Send WorkMesh message",
        category: "Dialog",
        run: () => {
          if (selectCommand()) return
          void send()
        },
      },
    ],
    bindings: tuiConfig.keybinds.gather("dialog.prompt", ["dialog.prompt.submit"]),
  }))

  onMount(() => {
    // IM 需要同时容纳消息滚动区和底部输入区，只扩大当前会话弹窗。
    dialog.setSize("xlarge")
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      textarea.focus()
      textarea.gotoLineEnd()
    }, 1)
  })

  return (
    <box
      height={Math.max(18, Math.floor(dimensions().height * 0.68))}
      paddingLeft={2}
      paddingRight={2}
      gap={1}
      flexGrow={1}
    >
      <box
        flexDirection="row"
        justifyContent="space-between"
        paddingBottom={1}
        border={["bottom"]}
        borderColor={theme.border}
        // OpenTUI 的拖动事件由左键按下后产生；标题栏是唯一可拖动区域，避免输入区误触移动窗口。
        onMouseDown={(event: MouseEvent) => {
          if (event.button !== 0) return
          event.preventDefault()
          dragOrigin = {
            x: event.x,
            y: event.y,
            offsetX: dialog.position.x,
            offsetY: dialog.position.y,
          }
          event.stopPropagation()
        }}
        onMouseDrag={(event: MouseEvent) => {
          if (!dragOrigin) return
          event.preventDefault()
          const maxX = Math.max(0, Math.floor(dimensions().width / 2))
          const maxY = Math.max(0, Math.floor(dimensions().height / 4))
          const x = Math.max(-maxX, Math.min(maxX, dragOrigin.offsetX + event.x - dragOrigin.x))
          const y = Math.max(-maxY, Math.min(maxY, dragOrigin.offsetY + event.y - dragOrigin.y))
          dialog.setPosition(x, y)
          event.stopPropagation()
        }}
        onMouseDragEnd={() => {
          dragOrigin = undefined
        }}
        onMouseUp={(event: MouseEvent) => {
          // 释放标题栏时不能冒泡到 Dialog 背景，否则会被误判为关闭弹窗。
          dragOrigin = undefined
          event.stopPropagation()
        }}
      >
        <box flexDirection="row" gap={1}>
          <text selectable={false} fg={theme.primary}>
            ●
          </text>
          <text selectable={false} attributes={TextAttributes.BOLD} fg={theme.text}>
            {props.title}
          </text>
          <text selectable={false} fg={theme.textMuted}>
            按住拖动
          </text>
        </box>
        <text selectable={false} fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>

      <scrollbox
        flexGrow={1}
        flexShrink={1}
        minHeight={8}
        paddingTop={1}
        paddingBottom={1}
        verticalScrollbarOptions={{ visible: true }}
        horizontalScrollbarOptions={{ visible: false }}
        stickyScroll={true}
        stickyStart="bottom"
      >
        <Show
          when={messages() !== undefined}
          fallback={
            <text fg="gray">
              {messages.error ? errorMessage(messages.error) : locale.t("messageLoadingTerminals")}
            </text>
          }
        >
          <For each={messages()?.items ?? []}>
            {(item, index) => {
              const own = item.senderTerminalId === localTerminalId()
              const previous = () => (messages()?.items ?? [])[index() - 1]
              const showDate = () => {
                const current = new Date(item.createdAt).toLocaleDateString()
                return !previous() || new Date(previous().createdAt).toLocaleDateString() !== current
              }
              const time = new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
              return (
                <box gap={0} paddingBottom={1}>
                  <Show when={showDate()}>
                    <box justifyContent="center" paddingBottom={1}>
                      <text fg={theme.textMuted}>{new Date(item.createdAt).toLocaleDateString()}</text>
                    </box>
                  </Show>
                  <box flexDirection="row" justifyContent={own ? "flex-end" : "flex-start"} gap={1}>
                    <Show when={!own}>
                      <text fg={theme.primary}>●</text>
                    </Show>
                    <box
                      maxWidth={52}
                      paddingLeft={2}
                      paddingRight={2}
                      paddingTop={1}
                      paddingBottom={1}
                      backgroundColor={own ? theme.primary : theme.backgroundElement}
                      onMouseUp={() => {
                        if (!textarea || textarea.isDestroyed) return
                        textarea.setText(item.message)
                        textarea.focus()
                        textarea.gotoLineEnd()
                      }}
                    >
                      <text fg={own ? theme.selectedListItemText : theme.text} wrapMode="word">
                        {item.message}
                      </text>
                    </box>
                    <Show when={own}>
                      <text fg={theme.primary}>●</text>
                    </Show>
                  </box>
                  <box justifyContent={own ? "flex-end" : "flex-start"}>
                    <text fg={theme.textMuted}>
                      {time} · {item.status}
                      {item.execution
                        ? ` · ${item.execution.agent === "build" ? "Build" : "Plan"}${item.execution.kind === "command" ? ` /${item.execution.name}` : ""}`
                        : ""}
                      {item.result ? " · 已生成回复" : ""}
                    </text>
                  </box>
                  <Show when={item.status === "processing" ? liveReplies()[item.id] : undefined}>
                    {(reply) => (
                      <box gap={0} paddingTop={1}>
                        <box flexDirection="row" justifyContent={!own ? "flex-end" : "flex-start"} gap={1}>
                          <Show when={own}>
                            <text fg={theme.primary}>●</text>
                          </Show>
                          <box
                            maxWidth={52}
                            paddingLeft={2}
                            paddingRight={2}
                            paddingTop={1}
                            paddingBottom={1}
                            backgroundColor={!own ? theme.primary : theme.backgroundElement}
                          >
                            <text fg={!own ? theme.selectedListItemText : theme.text} wrapMode="word">
                              {reply()}
                            </text>
                          </box>
                          <Show when={!own}>
                            <text fg={theme.primary}>●</text>
                          </Show>
                        </box>
                        <box justifyContent={!own ? "flex-end" : "flex-start"}>
                          <text fg={theme.textMuted}>实时回复中</text>
                        </box>
                      </box>
                    )}
                  </Show>
                </box>
              )
            }}
          </For>
          <Show when={(messages()?.items ?? []).length === 0}>
            <box paddingTop={3} justifyContent="center">
              <text fg={theme.textMuted}>{locale.t("messageComposePlaceholder")}</text>
            </box>
          </Show>
        </Show>
      </scrollbox>

      <box border={["top"]} borderColor={theme.border} paddingTop={1} gap={1} flexShrink={0}>
        <Show when={commandOptions().length > 0}>
          <box backgroundColor={theme.backgroundMenu}>
            <For each={commandOptions()}>
              {(command, index) => (
                <box
                  flexDirection="row"
                  gap={2}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={index() === commandIndex() ? theme.primary : undefined}
                  onMouseOver={() => setCommandIndex(index())}
                  onMouseUp={() => {
                    setCommandIndex(index())
                    selectCommand()
                  }}
                >
                  <text
                    width={24}
                    fg={index() === commandIndex() ? theme.selectedListItemText : theme.text}
                  >
                    {command.display}
                  </text>
                  <text
                    flexGrow={1}
                    fg={index() === commandIndex() ? theme.selectedListItemText : theme.textMuted}
                  >
                    {command.description ?? ""}
                  </text>
                </box>
              )}
            </For>
          </box>
        </Show>
        <textarea
          height={3}
          ref={(val: TextareaRenderable) => {
            textarea = val
            setTextareaTarget(val)
            val.traits = { status: "WORKMESH_MESSAGE" }
          }}
          placeholder={locale.t("messageComposePlaceholder")}
          placeholderColor={theme.textMuted}
          textColor={sending() ? theme.textMuted : theme.text}
          focusedTextColor={sending() ? theme.textMuted : theme.text}
          cursorColor={sending() ? theme.backgroundElement : theme.primary}
          cursorStyle={tuiConfig.cursor}
          onContentChange={() => setDraft(textarea.plainText)}
          onKeyDown={(event: KeyEvent) => {
            if (event.name === "tab") {
              event.preventDefault()
              toggleAgent()
              return
            }
            if (commandOptions().length === 0) return
            if (event.name === "up" || event.name === "down") {
              event.preventDefault()
              moveCommand(event.name === "up" ? -1 : 1)
            }
          }}
        />
        <box flexDirection="row" justifyContent="space-between" alignItems="center">
          <box flexDirection="row" gap={2}>
            <text fg={agent() === "build" ? theme.primary : theme.textMuted} onMouseUp={() => selectAgent("build")}>
              Build
            </text>
            <text fg={agent() === "plan" ? theme.primary : theme.textMuted} onMouseUp={() => selectAgent("plan")}>
              Plan
            </text>
            <text fg={theme.textMuted}>tab 切换 · {submitShortcut() ?? "enter"}</text>
          </box>
          <box
            paddingLeft={3}
            paddingRight={3}
            backgroundColor={sending() ? theme.backgroundElement : theme.primary}
            onMouseUp={() => void send()}
          >
            <text fg={sending() ? theme.textMuted : theme.selectedListItemText}>{sending() ? "..." : "发送"}</text>
          </box>
        </box>
      </box>
    </box>
  )
}

function workMeshEventLabel(kind: TuiWorkmeshEventsResponse["items"][number]["kind"]) {
  const labels: Record<typeof kind, string> = {
    "assistant.text": "回复",
    "assistant.reasoning": "思考",
    "tool.input": "工具输入",
    "tool.output": "工具输出",
    "shell.output": "终端输出",
    "permission.asked": "权限请求",
    "permission.replied": "权限回复",
    "question.asked": "提问",
    "question.replied": "回答",
    "session.status": "会话状态",
    "session.error": "会话错误",
    "task.completed": "任务完成",
    "task.failed": "任务失败",
    truncated: "输出截断",
  }
  return labels[kind]
}
