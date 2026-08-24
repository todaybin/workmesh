import { Database } from "@opencode-ai/core/database/database"
import { Effect, ManagedRuntime } from "effect"
import { createLocalCoordinator, type LocalCoordinator } from "./coordinator"
import { WorkMeshRuntimeLayout } from "./runtime-layout"
import { createRelayCoordinator, gatewayConfig } from "./relay-coordinator"

const runtimes = new Map<string, ManagedRuntime.ManagedRuntime<Database.Service, never>>()
const databases = new Map<string, Database.Interface["db"]>()
const coordinators = new WeakMap<object, Promise<LocalCoordinator>>()

/**
 * 创建当前项目的终端协调器。
 *
 * 本地 SQLite 永远是消息权威来源；远程 Relay 只在发送目标明确为远程终端时参与投递，
 * 不能再通过全局环境变量替换整个 Coordinator。
 */
export async function createWorkMeshCoordinator(projectRoot: string, db?: Database.Interface["db"]) {
  const layout = await WorkMeshRuntimeLayout.ensureRuntimeLayout(projectRoot)
  const database = db ?? (await databaseForLayout(layout.database))
  const cached = coordinators.get(database as object)
  if (cached) return cached
  const coordinator = createLocalCoordinator(layout.projectRoot, database).then((local) => {
    const config = gatewayConfig()
    return config ? createRelayCoordinator(local, database, layout.projectRoot, config) : local
  })
  coordinators.set(database as object, coordinator)
  return coordinator
}

async function databaseForLayout(filename: string) {
  const cached = databases.get(filename)
  if (cached) return cached
  const runtime = runtimes.get(filename) ?? ManagedRuntime.make(Database.layerFromPath(filename))
  runtimes.set(filename, runtime)
  const database = (
    await runtime.runPromise(
      Effect.gen(function* () {
        return yield* Database.Service
      }),
    )
  ).db
  databases.set(filename, database)
  return database
}

/** 关闭指定项目由 Coordinator Service 持有的 SQLite 运行时，供服务退出和隔离测试清理资源。 */
export async function disposeWorkMeshCoordinator(projectRoot: string) {
  const filename = WorkMeshRuntimeLayout.layoutForRoot(
    await WorkMeshRuntimeLayout.resolveProjectRoot(projectRoot),
  ).database
  const database = databases.get(filename)
  if (database) coordinators.delete(database as object)
  databases.delete(filename)
  const runtime = runtimes.get(filename)
  runtimes.delete(filename)
  await runtime?.dispose()
}
