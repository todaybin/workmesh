import path from "path"
import fs from "fs/promises"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import os from "os"
import { Context, Effect, Layer } from "effect"
import { Flock } from "./util/flock"
import { Flag } from "./flag/flag"
import { makeGlobalNode } from "./effect/app-node"
import { WorkMeshCustomization } from "./workmesh/customization"
import { WorkMeshRuntimeLayout } from "./workmesh/runtime-layout"

const app = "opencode"
const project = WorkMeshRuntimeLayout.enabled
  ? WorkMeshRuntimeLayout.layoutForRoot(await WorkMeshRuntimeLayout.resolveProjectRoot(process.cwd()))
  : undefined
const data = project ? (process.env.WORKMESH_OPENCODE_DATA_HOME ?? project.data) : path.join(xdgData!, app)
const cache = project ? (process.env.WORKMESH_OPENCODE_CACHE_HOME ?? project.cache) : path.join(xdgCache!, app)
const config = project ? (process.env.WORKMESH_OPENCODE_CONFIG_HOME ?? project.config) : path.join(xdgConfig!, app)
const state = project ? (process.env.WORKMESH_OPENCODE_STATE_HOME ?? project.state) : path.join(xdgState!, app)
const tmp = project ? (process.env.WORKMESH_OPENCODE_TEMP_HOME ?? project.temp) : path.join(os.tmpdir(), app)

const paths = {
  get home() {
    return process.env.OPENCODE_TEST_HOME ?? os.homedir()
  },
  data,
  bin: path.join(cache, "bin"),
  log: project ? project.logs : path.join(data, "log"),
  repos: path.join(data, "repos"),
  cache,
  config,
  state,
  tmp,
}

export const Path = paths

Flock.setGlobal({ state })

await Promise.all([
  fs.mkdir(Path.data, { recursive: true }),
  fs.mkdir(Path.config, { recursive: true }),
  fs.mkdir(Path.state, { recursive: true }),
  fs.mkdir(Path.tmp, { recursive: true }),
  fs.mkdir(Path.log, { recursive: true }),
  fs.mkdir(Path.bin, { recursive: true }),
  fs.mkdir(Path.repos, { recursive: true }),
])

export class Service extends Context.Service<Service, Interface>()("@opencode/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
}

export function make(input: Partial<Interface> = {}): Interface {
  const customConfig = Flag.OPENCODE_CONFIG_DIR
  const configDir =
    customConfig && (!WorkMeshRuntimeLayout.enabled || !WorkMeshCustomization.isLegacyPath(customConfig))
      ? customConfig
      : Path.config
  return {
    home: Path.home,
    data: Path.data,
    cache: Path.cache,
    config: configDir,
    state: Path.state,
    tmp: Path.tmp,
    bin: Path.bin,
    log: Path.log,
    repos: Path.repos,
    ...input,
  }
}

const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [] })

export const layerWith = (input: Partial<Interface>) =>
  Layer.effect(
    Service,
    Effect.sync(() => Service.of(make(input))),
  )

export * as Global from "./global"
