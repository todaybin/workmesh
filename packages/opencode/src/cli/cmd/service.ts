import type { Argv } from "yargs"
import path from "node:path"
import { open, readFile } from "node:fs/promises"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { cmd } from "./cmd"
import { ensureRuntimeLayout } from "@/workmesh/runtime-layout"
import {
  discoverProjectService,
  projectServiceStatus,
  startProjectService,
  stopProjectService,
} from "@/workmesh/project-service"

type DirectoryArgs = { directory: string }

const directory = (yargs: Argv) =>
  yargs.option("directory", {
    alias: "C",
    describe: "项目目录，默认使用当前目录",
    type: "string",
    default: process.cwd(),
  })

const StartCommand = cmd<{}, DirectoryArgs>({
  command: "start",
  describe: "在后台启动当前项目的 WorkMesh 服务",
  builder: directory,
  async handler(args) {
    await start(args.directory)
  },
})

const ForegroundCommand = cmd<{}, DirectoryArgs>({
  command: "foreground",
  describe: "在前台运行当前项目的 WorkMesh 服务",
  builder: directory,
  async handler(args) {
    const { Server } = await import("../../server/server")
    const service = await startProjectService({
      directory: args.directory,
      version: InstallationVersion,
      handler: (request) => Server.Default().app.fetch(request),
      onError: (error) => console.error(error),
    })
    console.log(`WorkMesh 项目服务正在监听：${service.registration.url}`)

    const shutdown = () => void service.stop().catch((error) => console.error(error))
    process.once("SIGINT", shutdown)
    process.once("SIGTERM", shutdown)
    try {
      await service.closed
    } finally {
      process.off("SIGINT", shutdown)
      process.off("SIGTERM", shutdown)
      await service.stop()
    }
  },
})

const StatusCommand = cmd<{}, DirectoryArgs>({
  command: "status",
  describe: "查看当前项目的 WorkMesh 服务状态",
  builder: directory,
  async handler(args) {
    const current = await projectServiceStatus(args.directory)
    if (current.status === "stopped") {
      console.log("WorkMesh 项目服务未启动")
      return
    }
    if (current.status === "unavailable") {
      console.error(`WorkMesh 项目服务不可用：${current.reason}`)
      process.exitCode = 1
      return
    }
    console.log("WorkMesh 项目服务运行中")
    console.log(`地址：${current.registration.url}`)
    console.log(`进程：${current.registration.pid}`)
    console.log(`实例：${current.registration.instanceId}`)
    console.log(`项目：${current.registration.projectRoot}`)
  },
})

const StopCommand = cmd<{}, DirectoryArgs>({
  command: "stop",
  describe: "停止当前项目的 WorkMesh 服务",
  builder: directory,
  async handler(args) {
    if (!(await stopProjectService(args.directory))) {
      console.log("WorkMesh 项目服务未启动")
      return
    }
    console.log("WorkMesh 项目服务已停止")
  },
})

const RestartCommand = cmd<{}, DirectoryArgs>({
  command: "restart",
  describe: "重启当前项目的 WorkMesh 服务",
  builder: directory,
  async handler(args) {
    const current = await projectServiceStatus(args.directory)
    if (current.status === "running") await stopProjectService(args.directory)
    await start(args.directory)
  },
})

export const WorkMeshServiceCommand = cmd({
  command: "service",
  describe: "管理当前项目唯一的 WorkMesh 后台服务",
  builder: (yargs: Argv) =>
    yargs
      .command(StartCommand)
      .command(ForegroundCommand)
      .command(StatusCommand)
      .command(StopCommand)
      .command(RestartCommand)
      .demandCommand(),
  async handler() {},
})

function foregroundCommand(projectRoot: string) {
  const args = ["service", "foreground", "--directory", projectRoot]
  if (!/^bun(?:\.exe)?$/i.test(path.basename(process.execPath))) return [process.execPath, ...args]
  return [process.execPath, "run", "--conditions=browser", path.resolve(import.meta.dir, "../../index.ts"), ...args]
}

async function start(directory: string) {
  const current = await projectServiceStatus(directory)
  if (current.status === "running") {
    console.log(`WorkMesh 项目服务已在运行：${current.registration.url}`)
    return
  }

  const layout = await ensureRuntimeLayout(directory)
  const log = await open(layout.serviceLog, "a")
  const child = Bun.spawn(foregroundCommand(layout.projectRoot), {
    cwd: layout.projectRoot,
    env: { ...process.env, WORKMESH_BUILD: "1" },
    detached: true,
    windowsHide: true,
    stdin: "ignore",
    stdout: log.fd,
    stderr: log.fd,
  })
  child.unref()
  await log.close()

  const stop = Date.now() + 15_000
  while (Date.now() < stop) {
    const service = await discoverProjectService(layout.projectRoot)
    if (service) {
      console.log(`WorkMesh 项目服务已启动：${service.url}`)
      console.log(`运行目录：${layout.root}`)
      return
    }
    if (child.exitCode !== null) break
    await Bun.sleep(100)
  }

  const tail = await readFile(layout.serviceLog, "utf8").catch(() => "")
  console.error(`WorkMesh 项目服务启动失败，日志：${layout.serviceLog}`)
  if (tail) console.error(tail.slice(-2_000).trimEnd())
  process.exitCode = 1
}
