import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { createEffect, createMemo, createResource, onCleanup, Show, For } from "solid-js"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../config"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { usePluginRuntime } from "../../plugin/runtime"

import { getScrollAcceleration } from "../../util/scroll"
import { WorkspaceLabel } from "../../component/workspace-label"
import { useSDK } from "../../context/sdk"
import { useDialog } from "../../ui/dialog"
import { DialogWorkMeshMessage } from "../../component/dialog-workmesh-message"
import { TuiProduct } from "../../product"

export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const pluginRuntime = usePluginRuntime()
  const project = useProject()
  const sync = useSync()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const session = createMemo(() => sync.session.get(props.sessionID))
  const workspace = () => {
    const workspaceID = session()?.workspaceID
    if (!workspaceID) return
    return project.workspace.get(workspaceID)
  }
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const sdk = useSDK()
  const dialog = useDialog()
  const [workmesh, { refetch: refetchWorkmesh }] = createResource(
    () => (TuiProduct.enabled ? props.sessionID : undefined),
    async (sessionID) => {
      if (!sessionID) return undefined
      const terminals = (await sdk.client.tui.workmesh.terminals({ sessionID }, { throwOnError: true })).data
      const messages = await sdk.client.tui.workmesh.messages({ sessionID }, { throwOnError: true })
      return { ...terminals, messages: messages.data.items }
    },
  )
  createEffect(() => {
    if (!TuiProduct.enabled) return
    const timer = setInterval(() => void refetchWorkmesh(), 5_000)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={42}
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position={props.overlay ? "absolute" : "relative"}
      >
        <scrollbox
          flexGrow={1}
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <box flexShrink={0} gap={1} paddingRight={1}>
            <pluginRuntime.Slot
              name="sidebar_title"
              mode="single_winner"
              session_id={props.sessionID}
              title={session()!.title}
              share_url={session()!.share?.url}
            >
              <box paddingRight={1}>
                <text fg={theme.text}>
                  <b>{session()!.title}</b>
                </text>
                <Show when={InstallationChannel !== "latest"}>
                  <text fg={theme.textMuted}>{props.sessionID}</text>
                </Show>
                <Show when={session()!.workspaceID}>
                  <text fg={theme.textMuted}>
                    <Show
                      when={workspace()}
                      fallback={<WorkspaceLabel type="unknown" name={session()!.workspaceID!} status="error" icon />}
                    >
                      {(item) => (
                        <WorkspaceLabel
                          type={item().type}
                          name={item().name}
                          status={project.workspace.status(item().id) ?? "error"}
                          icon
                        />
                      )}
                    </Show>
                  </text>
                </Show>
                <Show when={session()!.share?.url}>
                  <text fg={theme.textMuted}>{session()!.share!.url}</text>
                </Show>
              </box>
            </pluginRuntime.Slot>
            <pluginRuntime.Slot name="sidebar_content" session_id={props.sessionID} />
            <Show when={workmesh()}>
              {(mesh) => (
                <box gap={1} paddingTop={1}>
                  <text fg={theme.text}><b>WorkMesh 消息</b></text>
                  <text fg={theme.textMuted}>当前终端：{mesh().currentTerminalId}</text>
                  <For each={mesh().items.filter((item) => !item.current && item.status !== "offline")}>
                    {(item) => {
                      const pending = mesh().messages.filter((message) =>
                        (message.senderTerminalId === item.terminalId || message.recipientTerminalId === item.terminalId)
                        && !["completed", "failed", "read"].includes(message.status),
                      ).length
                      return (
                        <box
                          onMouseUp={() =>
                            dialog.replace(() => (
                              <DialogWorkMeshMessage
                                sessionID={props.sessionID}
                                targetTerminalId={item.terminalId}
                                targetTitle={item.displayName}
                                currentTerminalId={mesh().currentTerminalId}
                              />
                            ))
                          }
                        >
                          <text fg={item.status === "busy" ? theme.warning : theme.success}>
                            {item.displayName} · {item.status}{pending ? ` · ${pending} 条待处理` : ""}
                          </text>
                        </box>
                      )
                    }}
                  </For>
                </box>
              )}
            </Show>
          </box>
        </scrollbox>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <pluginRuntime.Slot name="sidebar_footer" mode="single_winner" session_id={props.sessionID}>
            <text fg={theme.textMuted}>
              <span style={{ fg: theme.success }}>•</span>{" "}
              <span style={{ fg: theme.text }}>
                <b>{TuiProduct.displayName}</b>
              </span>{" "}
              <span>{InstallationVersion}</span>
            </text>
          </pluginRuntime.Slot>
        </box>
      </box>
    </Show>
  )
}
