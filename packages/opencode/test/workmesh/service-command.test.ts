import { describe, expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { stopProjectService } from "@/workmesh/project-service"

const entry = path.resolve(import.meta.dir, "../../src/index.ts")

describe("WorkMesh service command", () => {
  test("starts, reports and stops the project service in Chinese", async () => {
    await using tmp = await tmpdir({
      git: true,
      dispose: (directory) => stopProjectService(directory).catch(() => false),
    })

    const start = await run(tmp.path, ["service", "start"])
    expect(start.exitCode, start.stderr).toBe(0)
    expect(start.stdout).toContain("WorkMesh 项目服务已启动")

    const status = await run(tmp.path, ["service", "status"])
    expect(status.exitCode, status.stderr).toBe(0)
    expect(status.stdout).toContain("WorkMesh 项目服务运行中")
    expect(status.stdout).toContain(`项目：${tmp.path}`)
    const firstInstance = /^实例：(.+)$/m.exec(status.stdout)?.[1]

    const restart = await run(tmp.path, ["service", "restart"])
    expect(restart.exitCode, restart.stderr).toBe(0)
    expect(restart.stdout).toContain("WorkMesh 项目服务已启动")
    const restarted = await run(tmp.path, ["service", "status"])
    expect(/^实例：(.+)$/m.exec(restarted.stdout)?.[1]).not.toBe(firstInstance)

    const stop = await run(tmp.path, ["service", "stop"])
    expect(stop.exitCode, stop.stderr).toBe(0)
    expect(stop.stdout).toContain("WorkMesh 项目服务已停止")
  }, 60_000)

  test(
    "does not register the service command in official mode",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const help = await run(tmp.path, ["--help"], false)

      expect(help.exitCode, help.stderr).toBe(0)
      expect(help.stdout + help.stderr).not.toContain("管理当前项目唯一的 WorkMesh 后台服务")
    },
    30_000,
  )
})

async function run(directory: string, args: string[], workmesh = true) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    WORKMESH_BUILD: workmesh ? "1" : "0",
    XDG_CONFIG_HOME: path.join(directory, ".tmp", "xdg", "config"),
    XDG_DATA_HOME: path.join(directory, ".tmp", "xdg", "data"),
    XDG_STATE_HOME: path.join(directory, ".tmp", "xdg", "state"),
    XDG_CACHE_HOME: path.join(directory, ".tmp", "xdg", "cache"),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_PURE: "1",
  }
  delete env.OPENCODE_DB

  const child = Bun.spawn([process.execPath, "run", "--conditions=browser", entry, ...args], {
    cwd: directory,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}
