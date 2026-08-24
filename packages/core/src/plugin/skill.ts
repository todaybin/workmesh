/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeOpencodeContent from "./skill/customize-opencode.md" with { type: "text" }
import { WorkMeshCustomization } from "../workmesh/customization"
import { WorkMeshRuntimeLayout } from "../workmesh/runtime-layout"

export const CustomizeOpencodeContent = customizeOpencodeContent
export const CustomizeWorkMeshContent = WorkMeshCustomization.adaptInstructions(customizeOpencodeContent)

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((draft) => {
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "customize-opencode",
            description: WorkMeshRuntimeLayout.enabled
              ? "Use ONLY when the user is editing or creating WorkMesh configuration under .workmesh/config, including workmesh.json, agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code."
              : "Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself.",
            location: AbsolutePath.make("/builtin/customize-opencode.md"),
            content: WorkMeshRuntimeLayout.enabled ? CustomizeWorkMeshContent : CustomizeOpencodeContent,
          }),
        }),
      )
    })
  }),
})
