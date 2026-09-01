import { describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdir, stat } from "node:fs/promises"
import { WorkMeshCustomization } from "../src/workmesh/customization"
import { pathToFileURL } from "node:url"
import { tmpdir } from "./fixture/tmpdir"

describe("WorkMesh project runtime", () => {
  test("defines branded customization paths and names", () => {
    const root = path.join("project", "root")
    expect(WorkMeshCustomization.directory(root)).toBe(path.join(root, ".workmesh", "config"))
    expect(WorkMeshCustomization.plans(root)).toBe(path.join(root, ".workmesh", "state", "plans"))
    expect(WorkMeshCustomization.configWriteNames[0]).toBe("workmesh.jsonc")
    expect(WorkMeshCustomization.configLoadNames).toEqual([
      "opencode.json",
      "opencode.jsonc",
      "workmesh.json",
      "workmesh.jsonc",
    ])
    expect(WorkMeshCustomization.adaptInstructions(".opencode/agents opencode.jsonc")).toBe(
      ".workmesh/config/agents workmesh.jsonc",
    )
    expect(WorkMeshCustomization.isLegacyPath(path.join(root, ".opencode", "agents"))).toBe(true)
    expect(WorkMeshCustomization.isLegacyPath(path.join(root, ".OPENCODE", "opencode.jsonc"))).toBe(true)
    expect(WorkMeshCustomization.isLegacyPath(path.join(root, ".workmesh", "config", "opencode.jsonc"))).toBe(false)
  })

  test("uses the Git root and ignores legacy user directories", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, ".git"))
    const nested = path.join(tmp.path, "packages", "example")
    const legacy = path.join(tmp.path, "legacy-user-data")
    await mkdir(nested, { recursive: true })

    const env: Record<string, string | undefined> = {
      ...process.env,
      WORKMESH_BUILD: "1",
      XDG_DATA_HOME: path.join(legacy, "data"),
      XDG_CACHE_HOME: path.join(legacy, "cache"),
      XDG_CONFIG_HOME: path.join(legacy, "config"),
      XDG_STATE_HOME: path.join(legacy, "state"),
      OPENCODE_CONFIG_DIR: path.join(tmp.path, ".opencode"),
    }
    delete env.WORKMESH_OPENCODE_DATA_HOME
    delete env.WORKMESH_OPENCODE_CACHE_HOME
    delete env.WORKMESH_OPENCODE_CONFIG_HOME
    delete env.WORKMESH_OPENCODE_STATE_HOME
    delete env.WORKMESH_OPENCODE_TEMP_HOME
    delete env.OPENCODE_DB

    const global = pathToFileURL(path.resolve(import.meta.dir, "../src/global.ts")).href
    const database = pathToFileURL(path.resolve(import.meta.dir, "../src/database/database.ts")).href
    const script = `
      const { Global } = await import(${JSON.stringify(global)})
      const { Database } = await import(${JSON.stringify(database)})
      console.log(JSON.stringify({ paths: Global.Path, service: Global.make(), database: Database.path() }))
    `
    const child = Bun.spawn([process.execPath, "--conditions=browser", "-e", script], {
      cwd: nested,
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exitCode, stderr).toBe(0)

    const result = JSON.parse(stdout)
    const root = path.join(tmp.path, ".workmesh")
    expect(result.paths).toMatchObject({
      data: path.join(root, "data"),
      cache: path.join(root, "cache"),
      config: path.join(root, "config"),
      state: path.join(root, "state"),
      tmp: path.join(root, "temp"),
      log: path.join(root, "logs"),
    })
    expect(result.database).toBe(path.join(root, "data", "workmesh.db"))
    expect(result.service.config).toBe(path.join(root, "config"))
    expect(
      await Promise.all(
        ["data", "cache", "config", "state"].map((directory) => exists(path.join(legacy, directory, "opencode"))),
      ),
    ).toEqual([false, false, false, false])
  })
})

function exists(file: string) {
  return stat(file)
    .then(() => true)
    .catch(() => false)
}
