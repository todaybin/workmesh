export * as Compose from "./compose"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt, optional, statics } from "./schema"

export const ID = Schema.String.check(Schema.isStartsWith("cmp_")).pipe(
  Schema.brand("Compose.ID"),
  statics((schema) => ({ create: () => schema.make(`cmp_${crypto.randomUUID().replaceAll("-", "")}`) })),
)
export type ID = typeof ID.Type

export const Mode = Schema.Literals(["automatic", "interactive"])
export type Mode = typeof Mode.Type

export const TaskType = Schema.Literals(["feature", "bugfix", "refactor", "feedback"])
export type TaskType = typeof TaskType.Type

export const Language = Schema.Literals(["auto", "zh-CN", "en"])
export type Language = typeof Language.Type

export const Phase = Schema.Literals([
  "orient",
  "grill",
  "spec",
  "brainstorm",
  "design",
  "awaiting_approval",
  "workspace",
  "implement",
  "verify",
  "review",
  "finalize",
  "report",
  "awaiting_finish",
  "completed",
  "cancelled",
  "failed",
  "discarded",
])
export type Phase = typeof Phase.Type

export const Status = Schema.Literals([
  "running",
  "awaiting_approval",
  "awaiting_finish",
  "cancelled",
  "failed",
  "completed",
  "discarded",
])
export type Status = typeof Status.Type

export const TaskStatus = Schema.Literals(["pending", "running", "completed", "failed", "cancelled"])
export type TaskStatus = typeof TaskStatus.Type

export const FinishAction = Schema.Literals(["local_merge", "create_pr", "push", "keep", "discard"])
export type FinishAction = typeof FinishAction.Type

export const FinishStage = Schema.Literals(["prepared", "git_completed", "cleanup_completed"])
export type FinishStage = typeof FinishStage.Type

export const WorkspaceStrategy = Schema.Literals(["clean_head", "include_working"])
export type WorkspaceStrategy = typeof WorkspaceStrategy.Type

export const FinishProgress = Schema.Struct({
  action: FinishAction,
  stage: FinishStage,
  startedAt: NonNegativeInt,
  gitCompletedAt: optional(NonNegativeInt),
  cleanupCompletedAt: optional(NonNegativeInt),
  message: optional(Schema.String),
  prURL: optional(Schema.String),
  removeWorktree: optional(Schema.Boolean),
  deleteBranch: optional(Schema.Boolean),
  forceRemove: optional(Schema.Boolean),
}).annotate({ identifier: "Compose.FinishProgress" })
export interface FinishProgress extends Schema.Schema.Type<typeof FinishProgress> {}

export const FixKind = Schema.Literals(["verify", "review"])
export type FixKind = typeof FixKind.Type

export const Task = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  acceptance: Schema.Array(Schema.String),
  dependsOn: Schema.Array(Schema.String),
  covers: Schema.Array(Schema.String),
  files: Schema.Array(Schema.String),
  status: TaskStatus,
  attempt: NonNegativeInt,
  worktree: optional(Schema.String),
  branch: optional(Schema.String),
  error: optional(Schema.String),
}).annotate({ identifier: "Compose.Task" })
export interface Task extends Schema.Schema.Type<typeof Task> {}

export const Amendment = Schema.Struct({
  revision: PositiveInt,
  instruction: Schema.String,
  createdAt: NonNegativeInt,
}).annotate({ identifier: "Compose.Amendment" })
export interface Amendment extends Schema.Schema.Type<typeof Amendment> {}

export const Spec = Schema.Struct({
  draftPath: Schema.String,
  sha256: Schema.String,
  approvedPath: optional(Schema.String),
  approvedSha256: optional(Schema.String),
  temporaryProjectCopy: optional(Schema.Boolean),
}).annotate({ identifier: "Compose.Spec" })
export interface Spec extends Schema.Schema.Type<typeof Spec> {}

export const Config = Schema.Struct({
  maxConcurrent: PositiveInt,
  isolateWorktrees: Schema.Boolean,
  skipBrainstorm: Schema.Boolean,
  skipReport: Schema.Boolean,
}).annotate({ identifier: "Compose.Config" })
export interface Config extends Schema.Schema.Type<typeof Config> {}

export const Git = Schema.Struct({
  baseBranch: optional(Schema.String),
  baseSha: optional(Schema.String),
  headSha: optional(Schema.String),
  baseDirty: optional(Schema.Boolean),
  workspaceStrategy: optional(WorkspaceStrategy),
  workingSnapshotPath: optional(Schema.String),
  workingSnapshotSha256: optional(Schema.String),
  reviewedTreeHash: optional(Schema.String),
  branch: optional(Schema.String),
  worktree: optional(Schema.String),
  commits: Schema.Array(Schema.String),
  finishAction: optional(FinishAction),
  finishProgress: optional(FinishProgress),
}).annotate({ identifier: "Compose.Git" })
export interface Git extends Schema.Schema.Type<typeof Git> {}

export const Info = Schema.Struct({
  schemaVersion: Schema.Literal("workmesh.compose.v1"),
  id: ID,
  projectRoot: Schema.String,
  sessionID: optional(Schema.String),
  mode: Mode,
  taskType: TaskType,
  task: Schema.String,
  featureName: optional(Schema.String),
  language: Language,
  phase: Phase,
  status: Status,
  executionOwnerID: optional(Schema.String),
  resumePhase: optional(Phase),
  revision: NonNegativeInt,
  verificationAttempts: optional(NonNegativeInt),
  reviewFixAttempts: optional(NonNegativeInt),
  pendingFixKind: optional(FixKind),
  pendingFixes: optional(Schema.Array(Schema.String)),
  verificationSummary: optional(Schema.String),
  reviewEvidencePath: optional(Schema.String),
  reviewSummary: optional(Schema.String),
  reportPath: optional(Schema.String),
  journalSeq: PositiveInt,
  createdAt: NonNegativeInt,
  updatedAt: NonNegativeInt,
  approvedAt: optional(NonNegativeInt),
  completedAt: optional(NonNegativeInt),
  lastError: optional(Schema.String),
  tasks: Schema.Array(Task),
  amendments: Schema.Array(Amendment),
  spec: optional(Spec),
  config: Config,
  git: Git,
}).annotate({ identifier: "Compose.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
