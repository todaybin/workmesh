export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Cause, Context, Effect, Layer } from "effect"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration"
import { InstallationChannel } from "../installation/version"
import { makeGlobalNode } from "../effect/app-node"
import { WorkMeshRuntimeLayout } from "../workmesh/runtime-layout"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

const layer = (filename: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = yield* makeDatabase

      yield* verifyIntegrity(db, filename)
      yield* db.run("PRAGMA journal_mode = WAL")
      yield* db.run("PRAGMA synchronous = NORMAL")
      yield* db.run("PRAGMA busy_timeout = 30000")
      yield* db.run("PRAGMA cache_size = -64000")
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* DatabaseMigration.apply(db, {
        filename,
        lockDir: join(Global.Path.state, "locks"),
        backupDir: WorkMeshRuntimeLayout.enabled ? join(Global.Path.data, "backups") : undefined,
      })
      yield* verifyIntegrity(db, filename)
      yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")

      return { db }
    }).pipe(
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause)
        return Effect.die(
          new Error(
            `SQLite 数据库初始化失败（${filename}）：${error instanceof Error ? error.message : String(error)}`,
            {
              cause: error,
            },
          ),
        )
      }),
    ),
  )

export function layerFromPath(filename: string) {
  return layer(filename).pipe(Layer.provide(sqliteLayer({ filename, disableWAL: true })))
}

export function path() {
  if (Flag.OPENCODE_DB) {
    if (Flag.OPENCODE_DB === ":memory:" || isAbsolute(Flag.OPENCODE_DB)) return Flag.OPENCODE_DB
    return join(Global.Path.data, Flag.OPENCODE_DB)
  }
  if (WorkMeshRuntimeLayout.enabled) return join(Global.Path.data, "workmesh.db")
  if (
    ["latest", "beta", "prod"].includes(InstallationChannel) ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
  )
    return join(Global.Path.data, "opencode.db")
  return join(Global.Path.data, `opencode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
}

export function verifyIntegrity(db: DatabaseShape, filename: string) {
  return Effect.gen(function* () {
    const rows = yield* db.all<{ quick_check: string }>("PRAGMA quick_check")
    const failures = rows.map((row) => row.quick_check).filter((value) => value !== "ok")
    if (failures.length === 0) return
    return yield* Effect.fail(
      new Error(`数据库完整性检查未通过，已停止写入：${failures.join("；")}。请从 data/backups 恢复。`),
    )
  }).pipe(
    Effect.mapError(
      (error) =>
        new Error(
          `数据库完整性检查失败，已停止写入（${filename}）：${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        ),
    ),
  )
}

export const node = makeGlobalNode({ service: Service, layer: layerFromPath(path()), deps: [] })
