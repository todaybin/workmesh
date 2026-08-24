export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Effect, Semaphore } from "effect"
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { migrations } from "./migration.gen"
import schema from "./schema.gen"
import path from "node:path"
import { mkdir, readdir, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { Flock } from "../util/flock"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
const lock = Semaphore.makeUnsafe(1)

export type Migration = {
  id: string
  up: (tx: Transaction) => Effect.Effect<void, unknown>
}

export type ApplyOptions = {
  filename?: string
  lockDir?: string
  backupDir?: string
  backupLimit?: number
}

export function apply(db: Database, options: ApplyOptions = {}) {
  const migrate = Effect.gen(function* () {
    const tables = yield* db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    if (tables.some((table) => table.name === "session")) {
      if (options.backupDir && options.filename && (yield* hasPending(db, migrations))) {
        yield* createBackup(db, {
          filename: options.filename,
          backupDir: options.backupDir,
          backupLimit: options.backupLimit,
        })
      }
      return yield* applyOnly(db, migrations)
    }
    if (tables.length > 0) return yield* Effect.die("Database is not empty and has no session table")
    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        yield* schema.up(tx)
        yield* tx.run(
          sql`CREATE TABLE ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
        )
        yield* Effect.forEach(migrations, (migration) =>
          tx.run(
            sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
          ),
        )
      }),
    )
  })

  const guarded =
    options.filename && options.filename !== ":memory:"
      ? Effect.acquireUseRelease(
          Effect.promise((signal) =>
            Flock.acquire(`database-migration:${path.resolve(options.filename!)}`, {
              dir: options.lockDir ?? path.join(path.dirname(options.filename!), ".locks"),
              signal,
            }),
          ),
          () => migrate,
          (lease) => Effect.promise(() => lease.release()),
        )
      : migrate

  return lock.withPermit(guarded)
}

export function createBackup(db: Database, input: { filename: string; backupDir: string; backupLimit?: number }) {
  return Effect.gen(function* () {
    const checkpoint = yield* db.get<{ busy: number; log: number; checkpointed: number }>(
      sql`PRAGMA wal_checkpoint(TRUNCATE)`,
    )
    if (!checkpoint || checkpoint.busy !== 0) {
      return yield* Effect.fail(new Error(`数据库 WAL 仍有未 checkpoint 的写入，拒绝备份：${input.filename}`))
    }

    yield* Effect.promise(() => mkdir(input.backupDir, { recursive: true }))
    const name = `${path.basename(input.filename, path.extname(input.filename))}-${new Date()
      .toISOString()
      .replaceAll(":", "-")}-${randomUUID().slice(0, 8)}.db`
    const target = path.join(input.backupDir, name)
    yield* db.run(sql`VACUUM INTO ${target}`)

    const prefix = `${path.basename(input.filename, path.extname(input.filename))}-`
    const backups = (yield* Effect.promise(() => readdir(input.backupDir)))
      .filter((file) => file.startsWith(prefix) && file.endsWith(".db"))
      .toSorted()
      .reverse()
    yield* Effect.forEach(
      backups.slice(input.backupLimit ?? 5),
      (file) => Effect.promise(() => rm(path.join(input.backupDir, file))),
      { discard: true },
    )
    return target
  })
}

function hasPending(db: Database, input: Migration[]) {
  return Effect.gen(function* () {
    const journal = yield* db.get<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration'`,
    )
    if (!journal) return input.length > 0
    const completed = new Set(
      (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
    )
    return input.some((migration) => !completed.has(migration.id))
  })
}

export function applyOnly(db: Database, input: Migration[]) {
  return Effect.gen(function* () {
    yield* db.run(
      sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
    )
    let completed = new Set(
      (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
    )
    if (completed.size === 0) {
      // Existing installs used Drizzle's migration journal. Seed the new
      // journal once so TypeScript migrations don't replay old SQL.
      if (
        yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${"__drizzle_migrations"}`)
      ) {
        yield* db.run(sql`
          INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
          SELECT name, ${Date.now()}
          FROM ${sql.identifier("__drizzle_migrations")}
          WHERE name IS NOT NULL
        `)
        completed = new Set(
          (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
        )
      }
    }

    for (const migration of input) {
      if (completed.has(migration.id)) continue
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* migration.up(tx)
          yield* tx.run(
            sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
          )
        }),
      )
    }
  })
}
