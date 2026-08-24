import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { WorkMeshBuiltinSkills } from "@/workmesh/builtin-skills"
import { Skill } from "@/skill"
import { provideTmpdirInstance, testInstanceStoreLayer, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(Skill.node), LayerNode.compile(CrossSpawnSpawner.node), testInstanceStoreLayer),
)

describe("WorkMesh built-in skill directories", () => {
  test("prefers an explicit project launcher path and finds the nearest packaged root", async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    const root = path.join(tmp.path, "dist", "workmesh")
    const executable = path.join(root, "bin", "workmesh", "windows-x64", "workmesh.exe")
    await fs.mkdir(path.join(root, "builtin", "skills"), { recursive: true })
    expect(
      WorkMeshBuiltinSkills.directories({
        directory,
        executable,
        configured: "resources/skills",
      }),
    ).toEqual([path.resolve(directory, "resources/skills"), path.join(root, "builtin", "skills")])
  })

  test("finds skills from an arbitrarily deep executable directory", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "runtime")
    const executable = path.join(root, "a", "b", "c", "d", "workmesh.exe")
    await fs.mkdir(path.join(root, "builtin", "skills"), { recursive: true })
    expect(WorkMeshBuiltinSkills.directories({ directory: path.join(tmp.path, "project"), executable })).toEqual([
      path.join(root, "builtin", "skills"),
    ])
  })

  it.live("discovers configured built-in skills only in WorkMesh mode", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previousBuild = process.env.WORKMESH_BUILD
        const previousSkills = process.env.WORKMESH_BUILTIN_SKILLS_DIR
        process.env.WORKMESH_BUILD = "1"
        return { previousBuild, previousSkills }
      }),
      () =>
        provideTmpdirInstance(
          (directory) =>
            Effect.gen(function* () {
              const skills = path.join(directory, "builtin-skills")
              process.env.WORKMESH_BUILTIN_SKILLS_DIR = skills
              yield* Effect.promise(() =>
                fs
                  .mkdir(path.join(skills, "office"), { recursive: true })
                  .then(() =>
                    fs.writeFile(
                      path.join(skills, "office", "SKILL.md"),
                      "---\nname: office-test\ndescription: Office test skill.\n---\n\n# Office\n",
                      "utf8",
                    ),
                  ),
              )
              const skill = yield* Skill.Service
              expect((yield* skill.all()).map((item) => item.name)).toContain("office-test")
            }),
          { git: true },
        ),
      ({ previousBuild, previousSkills }) =>
        Effect.sync(() => {
          if (previousBuild === undefined) delete process.env.WORKMESH_BUILD
          else process.env.WORKMESH_BUILD = previousBuild
          if (previousSkills === undefined) delete process.env.WORKMESH_BUILTIN_SKILLS_DIR
          else process.env.WORKMESH_BUILTIN_SKILLS_DIR = previousSkills
        }),
    ),
  )
})
