import { TuiEvent } from "@/server/tui-event"
import { TuiRequest as TuiRequestPayload } from "@/server/shared/tui-control"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { ApiNotFoundError } from "../errors"
import { described } from "./metadata"
import { InvalidRequestError } from "../errors"
import { SessionID } from "@/session/schema"

const root = "/tui"
export const CommandPayload = Schema.Struct({ command: Schema.String })
export const WorkMeshTerminalQuery = Schema.Struct({
  ...WorkspaceRoutingQuery.fields,
  sessionID: SessionID,
  status: Schema.optional(Schema.Literals(["online", "busy", "away"])),
})
const WorkMeshExecutionAgent = Schema.Literals(["build", "plan"])
const WorkMeshMessageExecution = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("prompt"), agent: WorkMeshExecutionAgent }),
  Schema.Struct({
    kind: Schema.Literal("command"),
    agent: WorkMeshExecutionAgent,
    name: Schema.String,
    arguments: Schema.String,
  }),
])
export const WorkMeshMessagePayload = Schema.Struct({
  sessionID: SessionID,
  recipientTerminalId: Schema.String,
  message: Schema.String,
  execution: Schema.optional(WorkMeshMessageExecution),
  replyToMessageId: Schema.optional(Schema.String),
})
export const WorkMeshMessagesQuery = Schema.Struct({
  ...WorkspaceRoutingQuery.fields,
  sessionID: SessionID,
  peerTerminalId: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["online", "busy", "away"])),
})
export const WorkMeshMessageEventsQuery = Schema.Struct({
  ...WorkspaceRoutingQuery.fields,
  sessionID: SessionID,
  peerTerminalId: Schema.String,
  after: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(500)),
  ),
})
export const WorkMeshMessageActionPayload = Schema.Struct({
  sessionID: SessionID,
  messageId: Schema.String,
  result: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["online", "busy", "away"])),
})
const WorkMeshMessageEventKind = Schema.Literals([
  "assistant.text",
  "assistant.reasoning",
  "tool.input",
  "tool.output",
  "shell.output",
  "permission.asked",
  "permission.replied",
  "question.asked",
  "question.replied",
  "session.status",
  "session.error",
  "task.completed",
  "task.failed",
  "truncated",
])
/** 模型执行过程写入本地 SQLite 事件表，不改变消息最终结果语义。 */
export const WorkMeshMessageProgressPayload = Schema.Struct({
  sessionID: SessionID,
  messageId: Schema.String,
  delta: Schema.String,
  content: Schema.String,
  sequence: Schema.Number,
  kind: Schema.optional(WorkMeshMessageEventKind),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
const WorkMeshTerminal = Schema.Struct({
  terminalId: Schema.String,
  displayName: Schema.String,
  role: Schema.optional(Schema.String),
  status: Schema.Literals(["online", "busy", "away", "offline"]),
  workspaceMode: Schema.Literals(["shared", "locked", "isolated"]),
  current: Schema.Boolean,
})
const WorkMeshTerminalList = Schema.Struct({
  currentTerminalId: Schema.String,
  items: Schema.Array(WorkMeshTerminal),
})
const WorkMeshMessageResult = Schema.Struct({ id: Schema.String, status: Schema.String })
const WorkMeshMessageItem = Schema.Struct({
  id: Schema.String,
  senderTerminalId: Schema.String,
  recipientTerminalId: Schema.String,
  message: Schema.String,
  execution: Schema.optional(WorkMeshMessageExecution),
  status: Schema.String,
  claimedByTerminalId: Schema.optional(Schema.String),
  claimedAt: Schema.optional(Schema.String),
  replyToMessageId: Schema.optional(Schema.String),
  createdAt: Schema.String,
  completedAt: Schema.optional(Schema.String),
  result: Schema.optional(Schema.String),
})
const WorkMeshMessagesResult = Schema.Struct({ items: Schema.Array(WorkMeshMessageItem) })
const WorkMeshMessageEvent = Schema.Struct({
  cursor: Schema.Number,
  id: Schema.String,
  messageId: Schema.String,
  terminalId: Schema.String,
  sequence: Schema.Number,
  kind: WorkMeshMessageEventKind,
  content: Schema.String,
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  createdAt: Schema.String,
})
const WorkMeshMessageEventsResult = Schema.Struct({
  items: Schema.Array(WorkMeshMessageEvent),
  nextCursor: Schema.Number,
})
const EventTuiPromptAppend = Schema.Struct({
  type: Schema.Literal(TuiEvent.PromptAppend.type),
  properties: TuiEvent.PromptAppend.data,
}).annotate({ identifier: "EventTuiPromptAppend" })
const EventTuiCommandExecute = Schema.Struct({
  type: Schema.Literal(TuiEvent.CommandExecute.type),
  properties: TuiEvent.CommandExecute.data,
}).annotate({ identifier: "EventTuiCommandExecute" })
const EventTuiToastShow = Schema.Struct({
  type: Schema.Literal(TuiEvent.ToastShow.type),
  properties: TuiEvent.ToastShow.data,
}).annotate({ identifier: "EventTuiToastShow" })
const EventTuiSessionSelect = Schema.Struct({
  type: Schema.Literal(TuiEvent.SessionSelect.type),
  properties: TuiEvent.SessionSelect.data,
}).annotate({ identifier: "EventTuiSessionSelect" })
export const TuiPublishPayload = Schema.Union([
  EventTuiPromptAppend,
  EventTuiCommandExecute,
  EventTuiToastShow,
  EventTuiSessionSelect,
])

export const TuiPaths = {
  appendPrompt: `${root}/append-prompt`,
  openHelp: `${root}/open-help`,
  openSessions: `${root}/open-sessions`,
  openThemes: `${root}/open-themes`,
  openModels: `${root}/open-models`,
  submitPrompt: `${root}/submit-prompt`,
  clearPrompt: `${root}/clear-prompt`,
  executeCommand: `${root}/execute-command`,
  showToast: `${root}/show-toast`,
  publish: `${root}/publish`,
  selectSession: `${root}/select-session`,
  controlNext: `${root}/control/next`,
  controlResponse: `${root}/control/response`,
  workmeshTerminals: `${root}/workmesh/terminals`,
  workmeshMessage: `${root}/workmesh/message`,
  workmeshMessages: `${root}/workmesh/messages`,
  workmeshMessageEvents: `${root}/workmesh/message/events`,
  workmeshMessageClaim: `${root}/workmesh/message/claim`,
  workmeshMessageComplete: `${root}/workmesh/message/complete`,
  workmeshMessageFail: `${root}/workmesh/message/fail`,
  workmeshMessageProgress: `${root}/workmesh/message/progress`,
} as const

export const TuiApi = HttpApi.make("tui")
  .add(
    HttpApiGroup.make("tui")
      .add(
        HttpApiEndpoint.post("appendPrompt", TuiPaths.appendPrompt, {
          query: WorkspaceRoutingQuery,
          payload: TuiEvent.PromptAppend.data,
          success: described(Schema.Boolean, "Prompt processed successfully"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.appendPrompt",
            summary: "Append TUI prompt",
            description: "Append prompt to the TUI.",
          }),
        ),
        HttpApiEndpoint.post("openHelp", TuiPaths.openHelp, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Help dialog opened successfully"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.openHelp",
            summary: "Open help dialog",
            description: "Open the help dialog in the TUI to display user assistance information.",
          }),
        ),
        HttpApiEndpoint.post("openSessions", TuiPaths.openSessions, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Session dialog opened successfully"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.openSessions",
            summary: "Open sessions dialog",
            description: "Open the session dialog.",
          }),
        ),
        HttpApiEndpoint.post("openThemes", TuiPaths.openThemes, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Theme dialog opened successfully"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.openThemes",
            summary: "Open themes dialog",
            description: "Open the theme dialog.",
          }),
        ),
        HttpApiEndpoint.post("openModels", TuiPaths.openModels, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Model dialog opened successfully"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.openModels",
            summary: "Open models dialog",
            description: "Open the model dialog.",
          }),
        ),
        HttpApiEndpoint.post("submitPrompt", TuiPaths.submitPrompt, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Prompt submitted successfully"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.submitPrompt",
            summary: "Submit TUI prompt",
            description: "Submit the prompt.",
          }),
        ),
        HttpApiEndpoint.post("clearPrompt", TuiPaths.clearPrompt, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Prompt cleared successfully"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.clearPrompt",
            summary: "Clear TUI prompt",
            description: "Clear the prompt.",
          }),
        ),
        HttpApiEndpoint.post("executeCommand", TuiPaths.executeCommand, {
          query: WorkspaceRoutingQuery,
          payload: CommandPayload,
          success: described(Schema.Boolean, "Command executed successfully"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.executeCommand",
            summary: "Execute TUI command",
            description: "Execute a TUI command.",
          }),
        ),
        HttpApiEndpoint.post("showToast", TuiPaths.showToast, {
          query: WorkspaceRoutingQuery,
          payload: TuiEvent.ToastShow.data,
          success: described(Schema.Boolean, "Toast notification shown successfully"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.showToast",
            summary: "Show TUI toast",
            description: "Show a toast notification in the TUI.",
          }),
        ),
        HttpApiEndpoint.post("publish", TuiPaths.publish, {
          query: WorkspaceRoutingQuery,
          payload: TuiPublishPayload,
          success: described(Schema.Boolean, "Event published successfully"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.publish",
            summary: "Publish TUI event",
            description: "Publish a TUI event.",
          }),
        ),
        HttpApiEndpoint.post("selectSession", TuiPaths.selectSession, {
          query: WorkspaceRoutingQuery,
          payload: TuiEvent.SessionSelect.data,
          success: described(Schema.Boolean, "Session selected successfully"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.selectSession",
            summary: "Select session",
            description: "Navigate the TUI to display the specified session.",
          }),
        ),
        HttpApiEndpoint.get("controlNext", TuiPaths.controlNext, {
          query: WorkspaceRoutingQuery,
          success: described(TuiRequestPayload, "Next TUI request"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.control.next",
            summary: "Get next TUI request",
            description: "Retrieve the next TUI request from the queue for processing.",
          }),
        ),
        HttpApiEndpoint.post("controlResponse", TuiPaths.controlResponse, {
          query: WorkspaceRoutingQuery,
          payload: Schema.Unknown,
          success: described(Schema.Boolean, "Response submitted successfully"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.control.response",
            summary: "Submit TUI response",
            description: "Submit a response to the TUI request queue to complete a pending request.",
          }),
        ),
        HttpApiEndpoint.get("workmeshTerminals", TuiPaths.workmeshTerminals, {
          query: WorkMeshTerminalQuery,
          success: described(WorkMeshTerminalList, "WorkMesh terminals available for messaging"),
          error: InvalidRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.workmesh.terminals",
            summary: "List WorkMesh terminals",
            description: "Register the current WorkMesh session terminal and list messaging targets.",
          }),
        ),
        HttpApiEndpoint.post("workmeshMessage", TuiPaths.workmeshMessage, {
          query: WorkspaceRoutingQuery,
          payload: WorkMeshMessagePayload,
          success: described(WorkMeshMessageResult, "WorkMesh message queued"),
          error: InvalidRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.workmesh.message",
            summary: "Send WorkMesh terminal message",
            description: "Send one short message from the current WorkMesh session terminal.",
          }),
        ),
        HttpApiEndpoint.get("workmeshMessages", TuiPaths.workmeshMessages, {
          query: WorkMeshMessagesQuery,
          success: described(WorkMeshMessagesResult, "WorkMesh terminal conversation messages"),
          error: InvalidRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.workmesh.messages",
            summary: "List WorkMesh messages",
            description: "List the current terminal conversation messages.",
          }),
        ),
        HttpApiEndpoint.get("workmeshMessageEvents", TuiPaths.workmeshMessageEvents, {
          query: WorkMeshMessageEventsQuery,
          success: described(WorkMeshMessageEventsResult, "WorkMesh terminal message events after cursor"),
          error: InvalidRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.workmesh.events",
            summary: "List WorkMesh message events",
            description: "List local message execution events after the supplied cursor.",
          }),
        ),
        HttpApiEndpoint.post("workmeshMessageClaim", TuiPaths.workmeshMessageClaim, {
          query: WorkspaceRoutingQuery,
          payload: WorkMeshMessageActionPayload,
          success: described(WorkMeshMessageItem, "WorkMesh message claimed"),
          error: InvalidRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.workmesh.claim",
            summary: "Claim WorkMesh message",
            description: "Atomically claim a queued terminal task.",
          }),
        ),
        HttpApiEndpoint.post("workmeshMessageComplete", TuiPaths.workmeshMessageComplete, {
          query: WorkspaceRoutingQuery,
          payload: WorkMeshMessageActionPayload,
          success: described(WorkMeshMessageItem, "WorkMesh message completed"),
          error: InvalidRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.workmesh.complete",
            summary: "Complete WorkMesh message",
            description: "Report a terminal task result.",
          }),
        ),
        HttpApiEndpoint.post("workmeshMessageFail", TuiPaths.workmeshMessageFail, {
          query: WorkspaceRoutingQuery,
          payload: WorkMeshMessageActionPayload,
          success: described(WorkMeshMessageItem, "WorkMesh message failed"),
          error: InvalidRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.workmesh.fail",
            summary: "Fail WorkMesh message",
            description: "Report a terminal task failure.",
          }),
        ),
        HttpApiEndpoint.post("workmeshMessageProgress", TuiPaths.workmeshMessageProgress, {
          query: WorkspaceRoutingQuery,
          payload: WorkMeshMessageProgressPayload,
          success: described(Schema.Boolean, "WorkMesh message progress reported"),
          error: InvalidRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.workmesh.progress",
            summary: "Append WorkMesh task event",
            description: "Append an execution event for the current terminal task to local SQLite.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "tui", description: "Experimental HttpApi TUI routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
