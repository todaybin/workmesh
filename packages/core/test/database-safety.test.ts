import { describe, expect, test } from "bun:test"
import path from "node:path"
import { readdir, writeFile } from "node:fs/promises"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { tmpdir } from "./fixture/tmpdir"
import { pathToFileURL } from "node:url"

describe("SQLite safety", () => {
  test("rejects a corrupted database with Chinese context", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "corrupted.db")
    await writeFile(filename, "not-a-sqlite-database", "utf8")

    await expect(
      Effect.runPromise(Effect.scoped(Effect.provide(Effect.void, Database.layerFromPath(filename)))),
    ).rejects.toThrow(`SQLite 数据库初始化失败（${filename}）`)
  })

  test("uses a 30 second busy timeout", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "busy-timeout.db")

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Database.Service
        expect(yield* service.db.get<{ timeout: number }>(sql`PRAGMA busy_timeout`)).toEqual({ timeout: 30_000 })
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  })

  test("serializes migration across separate processes", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "multi-process.db")
    const database = pathToFileURL(path.resolve(import.meta.dir, "../src/database/database.ts")).href
    const script = `
      const { Effect, Layer } = await import("effect")
      const { Database } = await import(${JSON.stringify(database)})
      await Effect.runPromise(Effect.scoped(Layer.build(Database.layerFromPath(${JSON.stringify(filename)}))))
    `
    const env: Record<string, string | undefined> = {
      ...process.env,
      XDG_CONFIG_HOME: path.join(tmp.path, "xdg", "config"),
      XDG_DATA_HOME: path.join(tmp.path, "xdg", "data"),
      XDG_STATE_HOME: path.join(tmp.path, "xdg", "state"),
      XDG_CACHE_HOME: path.join(tmp.path, "xdg", "cache"),
    }
    delete env.OPENCODE_DB
    const children = Array.from({ length: 2 }, () =>
      Bun.spawn([process.execPath, "--conditions=browser", "-e", script], {
        cwd: import.meta.dir,
        env,
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    const results = await Promise.all(
      children.map(async (child) => ({
        exitCode: await child.exited,
        stderr: await new Response(child.stderr).text(),
      })),
    )
    expect(results, results.map((result) => result.stderr).join("\n")).toEqual([
      { exitCode: 0, stderr: "" },
      { exitCode: 0, stderr: "" },
    ])
  })

  test("creates recoverable checkpointed backups and enforces retention", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "source.db")
    const backupDir = path.join(tmp.path, "backups")

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Database.Service
        yield* service.db.run(sql`CREATE TABLE backup_probe (value TEXT NOT NULL)`)
        yield* service.db.run(sql`INSERT INTO backup_probe (value) VALUES ('ready')`)
        yield* DatabaseMigration.createBackup(service.db, { filename, backupDir, backupLimit: 2 })
        yield* service.db.run(sql`INSERT INTO backup_probe (value) VALUES ('second')`)
        yield* DatabaseMigration.createBackup(service.db, { filename, backupDir, backupLimit: 2 })
        yield* DatabaseMigration.createBackup(service.db, { filename, backupDir, backupLimit: 2 })
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )

    const backups = (await readdir(backupDir)).filter((file) => file.endsWith(".db"))
    expect(backups).toHaveLength(2)
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Database.Service
        expect(yield* service.db.all<{ value: string }>(sql`SELECT value FROM backup_probe ORDER BY rowid`)).toEqual([
          { value: "ready" },
          { value: "second" },
        ])
      }).pipe(Effect.provide(Database.layerFromPath(path.join(backupDir, backups[0]))), Effect.scoped),
    )
  })
})
