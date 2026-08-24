import path from "node:path"
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { ensureRuntimeLayout, type RuntimeLayout } from "./runtime-layout"

const SCHEMA_VERSION = "workmesh.project-service.v1"
const HEALTH_PATH = "/workmesh/health"
const SHUTDOWN_PATH = "/workmesh/shutdown"
const STARTUP_GRACE_MS = 10_000

export type ServiceRegistration = {
  schemaVersion: typeof SCHEMA_VERSION
  projectRoot: string
  instanceId: string
  version: string
  pid: number
  startedAt: string
  processStartedAt: string
  url: string
  tokenSha256: string
}

export type ProjectServiceStatus =
  | { status: "stopped"; layout: RuntimeLayout }
  | { status: "running"; layout: RuntimeLayout; registration: ServiceRegistration; token: string }
  | { status: "unavailable"; layout: RuntimeLayout; registration?: ServiceRegistration; reason: string }

export type ProjectServiceHandler = (
  request: Request,
  registration: ServiceRegistration,
) => Response | Promise<Response>

export type StartProjectServiceOptions = {
  directory: string
  version?: string
  port?: number
  handler?: ProjectServiceHandler
  onError?: (error: unknown) => void
  startupGraceMs?: number
}

export type ProjectServiceHandle = {
  layout: RuntimeLayout
  registration: ServiceRegistration
  token: string
  headers: Readonly<{ Authorization: string; "X-WorkMesh-Instance-ID": string }>
  closed: Promise<void>
  stop: () => Promise<void>
  [Symbol.asyncDispose]: () => Promise<void>
}

type ServiceLockOwner = {
  instanceId: string
  pid: number
  processStartedAt: string
  createdAt: string
}

export class ProjectServiceError extends Error {
  constructor(
    readonly code: "already-running" | "service-starting" | "invalid-registration" | "unauthorized",
    message: string,
  ) {
    super(message)
    this.name = "ProjectServiceError"
  }
}

export async function startProjectService(input: StartProjectServiceOptions): Promise<ProjectServiceHandle> {
  const layout = await ensureRuntimeLayout(input.directory)
  const current = await projectServiceStatus(layout.projectRoot)
  if (current.status === "running") {
    throw new ProjectServiceError("already-running", `WorkMesh 项目服务已在运行：${current.registration.url}`)
  }
  if (current.status === "unavailable" && current.registration && processAlive(current.registration.pid)) {
    throw new ProjectServiceError(
      "service-starting",
      `WorkMesh 项目服务进程 ${current.registration.pid} 仍然存在，拒绝启动第二个实例`,
    )
  }

  const instanceId = randomUUID()
  const processStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString()
  const lock = await acquireServiceLock(
    layout,
    {
      instanceId,
      pid: process.pid,
      processStartedAt,
      createdAt: new Date().toISOString(),
    },
    input.startupGraceMs,
  )
  const token = randomBytes(32).toString("base64url")
  const closed = Promise.withResolvers<void>()
  const state: {
    registration?: ServiceRegistration
    stopPromise?: Promise<void>
    stopServer?: () => Promise<void>
  } = {}

  try {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: input.port ?? 0,
      fetch: async (request) => {
        const registration = state.registration
        if (!registration) return json({ error: "服务正在启动" }, 503)
        if (!authorized(request, token, registration.instanceId)) return json({ error: "未授权" }, 401)

        const url = new URL(request.url)
        if (request.method === "GET" && url.pathname === HEALTH_PATH) {
          return json({ status: "ok", registration })
        }
        if (request.method === "POST" && url.pathname === SHUTDOWN_PATH) {
          setTimeout(() => void stop().catch(input.onError ?? console.error), 0).unref?.()
          return json({ status: "stopping", instanceId: registration.instanceId }, 202)
        }
        if (input.handler) return input.handler(request, registration)
        return json({ error: "未找到接口" }, 404)
      },
    })
    state.stopServer = () => server.stop(true)

    const registration: ServiceRegistration = {
      schemaVersion: SCHEMA_VERSION,
      projectRoot: layout.projectRoot,
      instanceId,
      version: input.version ?? process.env.WORKMESH_VERSION ?? "development",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      processStartedAt,
      url: `http://127.0.0.1:${server.port}`,
      tokenSha256: sha256(token),
    }
    state.registration = registration

    await Promise.all([rm(layout.serviceToken, { force: true }), rm(layout.serviceRegistration, { force: true })])
    await writeAtomic(layout.serviceToken, token, 0o600)
    await writeAtomic(layout.serviceRegistration, JSON.stringify(registration, null, 2) + "\n", 0o600)

    const stop = () => {
      if (state.stopPromise) return state.stopPromise
      const next = (async () => {
        await server.stop(true)
        await removeOwnedFile(layout.serviceRegistration, (value) => registrationOf(value)?.instanceId === instanceId)
        await removeOwnedFile(layout.serviceToken, (value) => sha256(value) === registration.tokenSha256)
        await lock.release()
      })()
      void next.then(closed.resolve, closed.resolve)
      state.stopPromise = next
      return next
    }

    return {
      layout,
      registration,
      token,
      headers: serviceHeaders(registration, token),
      closed: closed.promise,
      stop,
      [Symbol.asyncDispose]: stop,
    }
  } catch (error) {
    await state.stopServer?.()
    await removeOwnedFile(layout.serviceToken, (value) => sha256(value) === sha256(token))
    await lock.release()
    throw error
  }
}

export async function projectServiceStatus(directory: string): Promise<ProjectServiceStatus> {
  const layout = await ensureRuntimeLayout(directory)
  const raw = await readOptional(layout.serviceRegistration)
  if (raw === undefined) return { status: "stopped", layout }

  const registration = registrationOf(raw)
  if (!registration) {
    return { status: "unavailable", layout, reason: "service.json 格式无效" }
  }
  if (path.resolve(registration.projectRoot) !== path.resolve(layout.projectRoot)) {
    return { status: "unavailable", layout, registration, reason: "service.json 不属于当前项目" }
  }

  const token = await readOptional(layout.serviceToken)
  if (!token || sha256(token) !== registration.tokenSha256) {
    return { status: "unavailable", layout, registration, reason: "服务凭据缺失或不匹配" }
  }

  try {
    const response = await fetch(new URL(HEALTH_PATH, registration.url), {
      headers: serviceHeaders(registration, token),
      signal: AbortSignal.timeout(2_000),
    })
    if (!response.ok) {
      return { status: "unavailable", layout, registration, reason: `健康检查返回 HTTP ${response.status}` }
    }
    const body = await response.json()
    if (
      !isObject(body) ||
      body.status !== "ok" ||
      registrationOf(body.registration)?.instanceId !== registration.instanceId
    ) {
      return { status: "unavailable", layout, registration, reason: "健康检查实例标识不匹配" }
    }
    return { status: "running", layout, registration, token }
  } catch (error) {
    return { status: "unavailable", layout, registration, reason: errorMessage(error) }
  }
}

export async function stopProjectService(directory: string) {
  const current = await projectServiceStatus(directory)
  if (current.status === "stopped") return false
  if (current.status !== "running") {
    throw new ProjectServiceError("invalid-registration", `WorkMesh 项目服务不可用：${current.reason}`)
  }

  const response = await fetch(new URL(SHUTDOWN_PATH, current.registration.url), {
    method: "POST",
    headers: serviceHeaders(current.registration, current.token),
    signal: AbortSignal.timeout(2_000),
  })
  if (response.status === 401) throw new ProjectServiceError("unauthorized", "WorkMesh 项目服务拒绝关闭请求")
  if (!response.ok) throw new Error(`WorkMesh 项目服务关闭失败：HTTP ${response.status}`)
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if ((await projectServiceStatus(directory)).status === "stopped") return true
    await Bun.sleep(25)
  }
  throw new Error("WorkMesh 项目服务关闭超时")
}

export async function restartProjectService(input: StartProjectServiceOptions) {
  await stopProjectService(input.directory)
  return startProjectService(input)
}

export async function discoverProjectService(directory: string) {
  const current = await projectServiceStatus(directory)
  if (current.status !== "running") return
  return {
    url: current.registration.url,
    headers: serviceHeaders(current.registration, current.token),
    registration: current.registration,
  }
}

function serviceHeaders(registration: ServiceRegistration, token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "X-WorkMesh-Instance-ID": registration.instanceId,
  } as const
}

function authorized(request: Request, token: string, instanceId: string) {
  if (request.headers.get("x-workmesh-instance-id") !== instanceId) return false
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
  if (!provided) return false
  const expectedBytes = Buffer.from(token)
  const providedBytes = Buffer.from(provided)
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes)
}

async function acquireServiceLock(layout: RuntimeLayout, owner: ServiceLockOwner, startupGraceMs = STARTUP_GRACE_MS) {
  const lock = path.join(layout.locks, "project-service.lock")
  if (!(await createLock(lock, owner))) {
    const existing = await readLockOwner(lock)
    if (!existing && Date.now() - (await stat(lock)).mtimeMs < startupGraceMs) {
      throw new ProjectServiceError("service-starting", "WorkMesh 项目服务正在启动")
    }
    if (existing && processAlive(existing.pid)) {
      throw new ProjectServiceError("service-starting", `WorkMesh 项目服务进程 ${existing.pid} 正在启动或暂时不可用`)
    }

    await breakStaleLock(lock, owner.instanceId, startupGraceMs)
    if (!(await createLock(lock, owner))) {
      throw new ProjectServiceError("service-starting", "WorkMesh 项目服务启动锁已被其他进程取得")
    }
  }

  return {
    async release() {
      const current = await readLockOwner(lock)
      if (!current || current.instanceId !== owner.instanceId) {
        throw new Error("拒绝释放不属于当前实例的 WorkMesh 项目服务锁")
      }
      await rm(lock, { recursive: true })
    },
  }
}

async function createLock(lock: string, owner: ServiceLockOwner) {
  try {
    await mkdir(lock)
  } catch (error) {
    if (isCode(error, "EEXIST")) return false
    throw error
  }

  try {
    await writeFile(path.join(lock, "owner.json"), JSON.stringify(owner, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
    return true
  } catch (error) {
    await rm(lock, { recursive: true, force: true })
    throw error
  }
}

async function breakStaleLock(lock: string, contender: string, startupGraceMs: number) {
  const breaker = lock + ".breaker"
  try {
    await mkdir(breaker)
  } catch (error) {
    if (isCode(error, "EEXIST")) {
      throw new ProjectServiceError("service-starting", "其他进程正在恢复 WorkMesh 项目服务锁")
    }
    throw error
  }

  try {
    await writeFile(path.join(breaker, "owner"), contender, { encoding: "utf8", mode: 0o600 })
    const current = await readLockOwner(lock)
    const age = Date.now() - (await stat(lock)).mtimeMs
    if (current && processAlive(current.pid)) {
      throw new ProjectServiceError("service-starting", `WorkMesh 项目服务进程 ${current.pid} 仍然存在`)
    }
    if (!current && age < startupGraceMs) {
      throw new ProjectServiceError("service-starting", "WorkMesh 项目服务锁尚处于启动保护期")
    }
    await rm(lock, { recursive: true })
  } finally {
    await rm(breaker, { recursive: true, force: true })
  }
}

async function readLockOwner(lock: string): Promise<ServiceLockOwner | undefined> {
  const raw = await readOptional(path.join(lock, "owner.json"))
  if (!raw) return
  try {
    const value = JSON.parse(raw)
    if (!isObject(value)) return
    if (typeof value.instanceId !== "string" || typeof value.pid !== "number") return
    if (typeof value.processStartedAt !== "string" || typeof value.createdAt !== "string") return
    return value as ServiceLockOwner
  } catch {
    return
  }
}

function registrationOf(raw: unknown): ServiceRegistration | undefined {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw
    if (!isObject(value) || value.schemaVersion !== SCHEMA_VERSION) return
    if (typeof value.projectRoot !== "string" || typeof value.instanceId !== "string") return
    if (typeof value.version !== "string" || typeof value.pid !== "number") return
    if (typeof value.startedAt !== "string" || typeof value.processStartedAt !== "string") return
    if (typeof value.url !== "string" || typeof value.tokenSha256 !== "string") return
    const url = new URL(value.url)
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return
    return value as ServiceRegistration
  } catch {
    return
  }
}

async function writeAtomic(file: string, contents: string, mode: number) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode })
  await rename(temporary, file).catch(async (error) => {
    await rm(temporary, { force: true })
    throw error
  })
}

async function removeOwnedFile(file: string, owns: (value: string) => boolean) {
  const value = await readOptional(file)
  if (value === undefined || !owns(value)) return
  await rm(file)
}

async function readOptional(file: string) {
  return readFile(file, "utf8").catch((error) => {
    if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR")) return undefined
    throw error
  })
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isCode(error, "EPERM")
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function json(value: unknown, status: number = 200) {
  return Response.json(value, { status })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isCode(error: unknown, expected: string) {
  return typeof error === "object" && error !== null && "code" in error && error.code === expected
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export * as WorkMeshProjectService from "./project-service"
