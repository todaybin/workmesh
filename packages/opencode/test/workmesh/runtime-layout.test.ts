import { describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdir, readFile, stat } from "node:fs/promises"
import { tmpdir } from "../fixture/fixture"
import { ensureRuntimeLayout, layoutForRoot, resolveProjectRoot } from "@/workmesh/runtime-layout"

describe("WorkMesh runtime layout", () => {
  test("uses the nearest Git root", async () => {
    await using tmp = await tmpdir({ git: true })
    const nested = path.join(tmp.path, "packages", "example")
    await mkdir(nested, { recursive: true })

    expect(await resolveProjectRoot(nested)).toBe(tmp.path)
  })

  test("walks through a directory without its own Git marker", async () => {
    await using tmp = await tmpdir()

    expect(await resolveProjectRoot(tmp.path)).toBe(await resolveProjectRoot(path.dirname(tmp.path)))
  })

  test("creates the complete project-local layout", async () => {
    await using tmp = await tmpdir({ git: true })
    const layout = await ensureRuntimeLayout(tmp.path)

    expect(layout).toEqual(layoutForRoot(tmp.path))
    expect(layout.database).toBe(path.join(tmp.path, ".workmesh", "data", "workmesh.db"))
    expect(
      await Promise.all(
        [
          layout.config,
          layout.skillCache,
          layout.runtimeCache,
          layout.backups,
          layout.locks,
          layout.plans,
          layout.composeState,
          layout.composeLocks,
          layout.temp,
          layout.composeTemp,
          layout.logs,
        ].map((item) => stat(item).then((value) => value.isDirectory())),
      ),
    ).toEqual([true, true, true, true, true, true, true, true, true, true, true])
    expect(layout.plans).toBe(path.join(tmp.path, ".workmesh", "state", "plans"))
    expect(layout.composeState).toBe(path.join(tmp.path, ".workmesh", "state", "compose"))
    expect(layout.composeTemp).toBe(path.join(tmp.path, ".workmesh", "temp", "compose"))
    const ignore = await readFile(path.join(layout.root, ".gitignore"), "utf8")
    expect(ignore).toContain("/data/")
    expect(ignore).toContain("/config/language.json")
    expect(ignore).not.toContain("/.workmesh/")
  })

  test("rejects UNC paths before accessing the filesystem", async () => {
    expect(resolveProjectRoot("\\\\server\\share\\project")).rejects.toThrow("不支持 UNC 路径")
  })
})
