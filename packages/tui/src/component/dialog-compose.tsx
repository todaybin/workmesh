import { DialogSelect } from "../ui/dialog-select"
import { useWorkMeshLocale } from "../workmesh/locale"
import type { ComposeRunView } from "../workmesh/compose"

export type ComposeApprovalAction = "approve" | "approve_head" | "approve_working" | "revise" | "cancel"
export type ComposeFinishAction = "merge" | "pr" | "push" | "keep" | "discard"

export function DialogComposeApproval(props: {
  run: ComposeRunView
  onSelect: (action: ComposeApprovalAction) => void
}) {
  const locale = useWorkMeshLocale()
  return (
    <DialogSelect
      title={locale.t("composeApprovalTitle")}
      skipFilter={true}
      options={
        [
          ...(props.run.baseDirty
            ? [
                {
                  title: locale.t("composeApproveWorking"),
                  description: locale.t("composeApproveWorkingDescription"),
                  value: "approve_working" as const,
                },
                {
                  title: locale.t("composeApproveHead"),
                  description: locale.t("composeApproveHeadDescription"),
                  value: "approve_head" as const,
                },
              ]
            : [
                {
                  title: locale.t("composeApprove"),
                  description: locale.t("composeApprovalDescription"),
                  value: "approve" as const,
                },
              ]),
          { title: locale.t("composeRevise"), value: "revise" },
          { title: locale.t("composeCancel"), value: "cancel" },
        ] satisfies { title: string; description?: string; value: ComposeApprovalAction }[]
      }
      onSelect={(option) => props.onSelect(option.value)}
    />
  )
}

export function DialogComposeFinish(props: { run: ComposeRunView; onSelect: (action: ComposeFinishAction) => void }) {
  const locale = useWorkMeshLocale()
  const detail = [
    `${locale.t("composeBranch")}: ${props.run.branch ?? "-"}`,
    `${locale.t("composeBase")}: ${props.run.baseSha ?? "-"}`,
    `${locale.t("composeHead")}: ${props.run.headSha ?? "-"}`,
    `${locale.t("composeWorktree")}: ${props.run.worktree ?? "-"}`,
    `${locale.t("composeSpec")}: ${props.run.specPath ?? "-"}`,
  ].join("\n")
  return (
    <DialogSelect
      title={locale.t("composeFinishTitle")}
      skipFilter={true}
      options={
        [
          { title: locale.t("composeMerge"), description: detail, value: "merge" },
          { title: locale.t("composePr"), description: detail, value: "pr" },
          { title: locale.t("composePush"), description: detail, value: "push" },
          { title: locale.t("composeKeep"), description: detail, value: "keep" },
          { title: locale.t("composeDiscard"), description: detail, value: "discard" },
        ] satisfies { title: string; description?: string; value: ComposeFinishAction }[]
      }
      onSelect={(option) => props.onSelect(option.value)}
    />
  )
}
