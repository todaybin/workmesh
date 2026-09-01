import path from "node:path"
import { mkdir, realpath, stat, writeFile } from "node:fs/promises"

declare const WORKMESH_BUILD: boolean | undefined

export const enabled = typeof WORKMESH_BUILD === "boolean" ? WORKMESH_BUILD : process.env.WORKMESH_BUILD === "1"

export type RuntimeLayout = ReturnType<typeof layoutForRoot>

export async function resolveProjectRoot(directory: string) {
  requireLocalPath(directory)
  const start = await realpath(path.resolve(directory))
  requireLocalPath(start)

  for (let current = start; ; current = path.dirname(current)) {
    if (await exists(path.join(current, ".git"))) return current
    const parent = path.dirname(current)
    if (parent === current) return start
  }
}

export function layoutForRoot(projectRoot: string) {
  requireLocalPath(projectRoot)
  const root = path.join(projectRoot, ".workmesh")
  const cache = path.join(root, "cache")
  const data = path.join(root, "data")
  const state = path.join(root, "state")
  const locks = path.join(state, "locks")
  const plans = path.join(state, "plans")
  const temp = path.join(root, "temp")

  return {
    projectRoot,
    root,
    config: path.join(root, "config"),
    cache,
    skillCache: path.join(cache, "skills"),
    runtimeCache: path.join(cache, "runtimes"),
    data,
    database: path.join(data, "workmesh.db"),
    backups: path.join(data, "backups"),
    state,
    locks,
    plans,
    composeState: path.join(state, "compose"),
    composeLocks: path.join(locks, "compose"),
    serviceRegistration: path.join(state, "service.json"),
    serviceToken: path.join(state, "service.token"),
    temp,
    composeTemp: path.join(temp, "compose"),
    logs: path.join(root, "logs"),
    serviceLog: path.join(root, "logs", "service.log"),
  }
}

export async function ensureRuntimeLayout(directory: string) {
  const layout = layoutForRoot(await resolveProjectRoot(directory))
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
    ].map((item) => mkdir(item, { recursive: true })),
  )
  await writeFile(path.join(layout.root, ".gitignore"), WORKMESH_GITIGNORE, { encoding: "utf8", flag: "wx" }).catch(
    (error) => {
      if (isCode(error, "EEXIST")) return
      throw error
    },
  )
  return layout
}

// 可共享配置与运行数据同处 `.workmesh`，必须只忽略本机状态，不能屏蔽整个品牌目录。
const WORKMESH_GITIGNORE = [
  "/cache/",
  "/data/",
  "/logs/",
  "/state/",
  "/temp/",
  "/worktrees/",
  "/config/node_modules/",
  "/config/package.json",
  "/config/package-lock.json",
  "/config/pnpm-lock.yaml",
  "/config/yarn.lock",
  "/config/bun.lock",
  "/config/.gitignore",
  "/config/language.json",
  "/config/opencode.json",
  "/config/opencode.jsonc",
  "",
].join("\n")

function requireLocalPath(value: string) {
  if (/^(?:\\\\|\/\/)/.test(value)) {
    throw new Error(`WorkMesh 项目运行目录不支持 UNC 路径：${value}`)
  }
}

async function exists(file: string) {
  return stat(file)
    .then(() => true)
    .catch((error) => {
      if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR")) return false
      throw error
    })
}

function isCode(error: unknown, expected: string) {
  return typeof error === "object" && error !== null && "code" in error && error.code === expected
}

export * as WorkMeshRuntimeLayout from "./runtime-layout"
