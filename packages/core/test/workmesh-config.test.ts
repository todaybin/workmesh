import path from "node:path"
import fs from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { Policy } from "@opencode-ai/core/policy"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkMeshRuntimeLayout } from "@opencode-ai/core/workmesh/runtime-layout"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"

describe("WorkMesh configuration", () => {
  test.skipIf(!WorkMeshRuntimeLayout.enabled)("prefers branded files and ignores .opencode", async () => {
    await using tmp = await tmpdir()
    const global = path.join(tmp.path, ".workmesh", "config")
    const legacy = path.join(tmp.path, ".opencode")
    await Promise.all([global, legacy].map((directory) => fs.mkdir(directory, { recursive: true })))
    await Promise.all([
      fs.writeFile(path.join(tmp.path, "opencode.json"), JSON.stringify({ model: "compat/model" })),
      fs.writeFile(path.join(tmp.path, "workmesh.jsonc"), JSON.stringify({ model: "workmesh/model" })),
      fs.writeFile(path.join(legacy, "opencode.json"), JSON.stringify({ model: "disabled/model" })),
    ])

    const locationLayer = Layer.succeed(
      Location.Service,
      Location.Service.of(
        location(
          { directory: AbsolutePath.make(tmp.path) },
          { projectDirectory: AbsolutePath.make(tmp.path) },
        ),
      ),
    )
    const layer = AppNodeBuilder.build(LayerNode.group([Config.node, Policy.node]), [
      [Location.node, locationLayer],
      [Global.node, Global.layerWith({ config: global })],
    ])
    const entries = await Effect.runPromise(
      Config.Service.use((config) => config.entries()).pipe(Effect.provide(layer), Effect.scoped),
    )
    const documents = entries.filter((entry) => entry.type === "document")

    expect(documents.map((document) => document.path)).toEqual([
      path.join(tmp.path, "opencode.json"),
      path.join(tmp.path, "workmesh.jsonc"),
    ])
    expect(Config.latest(entries, "model")).toBe("workmesh/model")
    expect(entries.some((entry) => entry.path?.includes(`${path.sep}.opencode${path.sep}`))).toBe(false)
  })
})
