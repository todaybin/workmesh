import { mkdir, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import {
  composeCommandArguments,
  composeStateDirectory,
  formatComposeDialogKey,
  loadComposeRuns,
  mergeComposeRuns,
  parseComposeRunEvent,
} from "../../src/workmesh/compose"
import { tmpdir } from "../fixture/fixture"

describe("WorkMesh Compose TUI event", () => {
  test("only confirms finish actions", () => {
    expect(composeCommandArguments("cmp_1", "approve")).toBe("approve cmp_1")
    expect(composeCommandArguments("cmp_1", "approve_head")).toBe("approve_head cmp_1")
    expect(composeCommandArguments("cmp_1", "approve_working")).toBe("approve_working cmp_1")
    expect(composeCommandArguments("cmp_1", "revise", "修改要求")).toBe("revise cmp_1 修改要求")
    expect(composeCommandArguments("cmp_1", "cancel")).toBe("cancel cmp_1")

    for (const action of ["merge", "pr", "push", "keep", "discard"] as const) {
      expect(composeCommandArguments("cmp_1", action)).toBe(`${action} cmp_1 --confirmed`)
    }
  })

  test("normalizes a nested run update", () => {
    expect(
      parseComposeRunEvent({
        type: "compose.run.updated",
        properties: {
          run: {
            id: "run_1",
            sessionID: "session_1",
            status: "running",
            phase: "implement",
            completedTasks: 2,
            totalTasks: 5,
            updatedAt: 42,
          },
        },
      }),
    ).toEqual({
      id: "run_1",
      sessionID: "session_1",
      status: "running",
      stage: "implement",
      completedTasks: 2,
      totalTasks: 5,
      updatedAt: 42,
    })
  })

  test("derives task progress and rejects unrelated events", () => {
    expect(
      parseComposeRunEvent({
        type: "compose.run.updated",
        properties: {
          id: "run_2",
          status: "awaiting_finish",
          stage: "awaiting_finish",
          tasks: [{ status: "completed" }, { status: "running" }],
          git: {
            baseDirty: true,
            baseSha: "base",
            headSha: "head",
            branch: "workmesh/compose/cmp_1",
            worktree: "/project/.workmesh/worktrees/cmp_1",
          },
          spec: { approvedPath: "/project/docs/compose/spec/feature.md" },
        },
      }),
    ).toMatchObject({
      completedTasks: 1,
      totalTasks: 2,
      baseDirty: true,
      baseSha: "base",
      headSha: "head",
      branch: "workmesh/compose/cmp_1",
      worktree: "/project/.workmesh/worktrees/cmp_1",
      specPath: "/project/docs/compose/spec/feature.md",
    })
    expect(parseComposeRunEvent({ type: "session.updated", properties: {} })).toBeUndefined()
  })

  test("hydrates valid project-local snapshots and ignores unsafe entries", async () => {
    await using project = await tmpdir()
    await using outside = await tmpdir()
    const state = composeStateDirectory(project.path)
    const valid = path.join(state, "cmp_valid")
    const foreign = path.join(state, "cmp_foreign")
    await mkdir(valid, { recursive: true })
    await mkdir(foreign, { recursive: true })
    await writeFile(
      path.join(valid, "run.json"),
      JSON.stringify({
        id: "cmp_valid",
        projectRoot: project.path,
        sessionID: "session_1",
        status: "awaiting_finish",
        phase: "awaiting_finish",
        tasks: [{ status: "completed" }],
        updatedAt: 42,
      }),
      "utf8",
    )
    await writeFile(
      path.join(foreign, "run.json"),
      JSON.stringify({
        id: "cmp_foreign",
        projectRoot: outside.path,
        status: "running",
        phase: "implement",
      }),
      "utf8",
    )
    await symlink(outside.path, path.join(state, "cmp_symlink"), "junction")
    await writeFile(path.join(state, "not-a-run.json"), "{}", "utf8")

    expect(await loadComposeRuns(project.path)).toEqual([
      {
        id: "cmp_valid",
        sessionID: "session_1",
        status: "awaiting_finish",
        stage: "awaiting_finish",
        completedTasks: 1,
        totalTasks: 1,
        updatedAt: 42,
      },
    ])
  })

  test("keeps a newer live event when hydration has the same or older timestamp", () => {
    const live = {
      id: "cmp_live",
      status: "awaiting_finish" as const,
      stage: "awaiting_finish",
      completedTasks: 1,
      totalTasks: 1,
      updatedAt: 50,
    }
    const loaded = { ...live, status: "running" as const, stage: "verify", updatedAt: 50 }
    expect(mergeComposeRuns({ [live.id]: live }, [loaded])[live.id]).toBe(live)
    expect(formatComposeDialogKey(live, 1)).not.toBe(formatComposeDialogKey(live, 2))
  })
})
