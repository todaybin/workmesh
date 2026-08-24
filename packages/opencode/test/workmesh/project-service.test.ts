import { describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "../fixture/fixture"
import { ensureRuntimeLayout } from "@/workmesh/runtime-layout"
import {
  discoverProjectService,
  projectServiceStatus,
  restartProjectService,
  startProjectService,
  stopProjectService,
} from "@/workmesh/project-service"

describe("WorkMesh project service", () => {
  test("publishes authenticated health and application endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await using service = await startProjectService({
      directory: tmp.path,
      handler: (request) => Response.json({ path: new URL(request.url).pathname }),
    })

    const unauthorized = await fetch(new URL("/workmesh/health", service.registration.url))
    expect(unauthorized.status).toBe(401)

    const health = await fetch(new URL("/workmesh/health", service.registration.url), { headers: service.headers })
    expect(health.status).toBe(200)
    expect((await health.json()).registration.instanceId).toBe(service.registration.instanceId)

    const application = await fetch(new URL("/example", service.registration.url), { headers: service.headers })
    expect(await application.json()).toEqual({ path: "/example" })

    const registrationFile = await readFile(service.layout.serviceRegistration, "utf8")
    expect(registrationFile).not.toContain(service.token)
  })

  test("discovers one service and refuses a second instance", async () => {
    await using tmp = await tmpdir({ git: true })
    await using service = await startProjectService({ directory: tmp.path })

    const discovered = await discoverProjectService(path.join(tmp.path, ".git"))
    expect(discovered?.registration.instanceId).toBe(service.registration.instanceId)
    expect(startProjectService({ directory: tmp.path })).rejects.toMatchObject({
      code: "already-running",
    })
  })

  test("allows only one winner during concurrent startup", async () => {
    await using tmp = await tmpdir({ git: true })
    const attempts = await Promise.allSettled(
      Array.from({ length: 16 }, () => startProjectService({ directory: tmp.path })),
    )
    const started = attempts.filter((item) => item.status === "fulfilled")

    expect(started).toHaveLength(1)
    if (started[0]?.status === "fulfilled") await started[0].value.stop()
  })

  test("recovers a lock whose owner process no longer exists", async () => {
    await using tmp = await tmpdir({ git: true })
    const layout = await ensureRuntimeLayout(tmp.path)
    const lock = path.join(layout.locks, "project-service.lock")
    await mkdir(lock)
    await writeFile(
      path.join(lock, "owner.json"),
      JSON.stringify({
        instanceId: "dead-instance",
        pid: 2_147_483_647,
        processStartedAt: "2000-01-01T00:00:00.000Z",
        createdAt: "2000-01-01T00:00:00.000Z",
      }),
      "utf8",
    )

    await using service = await startProjectService({ directory: tmp.path, startupGraceMs: 0 })
    expect(service.registration.instanceId).not.toBe("dead-instance")
  })

  test("stops through the authenticated control endpoint", async () => {
    await using tmp = await tmpdir({ git: true })
    await using service = await startProjectService({ directory: tmp.path })

    expect(await stopProjectService(tmp.path)).toBe(true)
    expect((await projectServiceStatus(tmp.path)).status).toBe("stopped")
    expect(await Bun.file(service.layout.serviceToken).exists()).toBe(false)
  })

  test("restarts with a new authenticated instance", async () => {
    await using tmp = await tmpdir({ git: true })
    await using first = await startProjectService({ directory: tmp.path })
    await using second = await restartProjectService({ directory: tmp.path })

    expect(second.registration.instanceId).not.toBe(first.registration.instanceId)
    expect((await projectServiceStatus(tmp.path)).status).toBe("running")
  })

  test("does not start a second instance when a live service token is corrupted", async () => {
    await using tmp = await tmpdir({ git: true })
    await using service = await startProjectService({ directory: tmp.path })
    await writeFile(service.layout.serviceToken, "corrupted-token", "utf8")

    expect((await projectServiceStatus(tmp.path)).status).toBe("unavailable")
    expect(startProjectService({ directory: tmp.path })).rejects.toMatchObject({ code: "service-starting" })

    await writeFile(service.layout.serviceToken, service.token, "utf8")
  })
})
