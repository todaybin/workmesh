import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { Context, Effect, Layer, Schema } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { Auth } from "@/auth"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MessageV2 } from "./message-v2"
import type { SessionID } from "./schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

export type Goal = {
  condition: string
  react: number
}

const VerdictSchema = Schema.Struct({
  ok: Schema.Boolean,
  impossible: Schema.optional(Schema.Boolean),
  reason: Schema.String,
})

export type Verdict = Schema.Schema.Type<typeof VerdictSchema>

const JUDGE_SYSTEM = `You are the independent stop-condition judge for WorkMesh. Read the transcript and decide whether the user's condition is satisfied.

Return JSON only:
- {"ok":true,"reason":"specific transcript evidence"}
- {"ok":false,"reason":"what is still missing"}
- {"ok":false,"impossible":true,"reason":"why this cannot be achieved in this session"}

Require concrete transcript evidence. Use impossible only when the condition is genuinely unachievable, not merely slow or incomplete.`

const stateFile = path.join(Global.Path.state, "workmesh-goals.json")

async function loadGoals() {
  const text = await fs.readFile(stateFile, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return ""
    throw error
  })
  if (!text) return new Map<string, Goal>()
  const parsed = JSON.parse(text) as { goals?: Record<string, Goal> }
  return new Map(
    Object.entries(parsed.goals ?? {}).filter(
      ([, value]) => typeof value?.condition === "string" && Number.isInteger(value.react) && value.react >= 0,
    ),
  )
}

export interface Interface {
  readonly set: (sessionID: SessionID, condition: string) => Effect.Effect<void>
  readonly get: (sessionID: SessionID) => Effect.Effect<Goal | undefined>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
  readonly bumpReact: (sessionID: SessionID) => Effect.Effect<number>
  readonly evaluate: (input: {
    condition: string
    msgs: SessionV1.WithParts[]
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  }) => Effect.Effect<Verdict, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoal") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const auth = yield* Auth.Service
    const state = yield* InstanceState.make<{ goals: Map<string, Goal> }>(
      () =>
        Effect.tryPromise({
          try: loadGoals,
          catch: (error) => new Error(`无法读取 WorkMesh Goal 状态：${String(error)}`),
        }).pipe(Effect.orDie, Effect.map((goals) => ({ goals }))),
    )
    let persistQueue = Promise.resolve()

    const persist = Effect.fn("SessionGoal.persist")(function* () {
      const data = yield* InstanceState.get(state)
      const snapshot = JSON.stringify({
        schemaVersion: "workmesh.goals.v1",
        goals: Object.fromEntries(data.goals),
      })
      persistQueue = persistQueue.then(async () => {
        const temporary = `${stateFile}.${process.pid}.tmp`
        await fs.mkdir(path.dirname(stateFile), { recursive: true })
        await fs.writeFile(temporary, snapshot, "utf8")
        await fs.rename(temporary, stateFile)
      })
      yield* Effect.tryPromise({
        try: () => persistQueue,
        catch: (error) => new Error(`无法保存 WorkMesh Goal 状态：${String(error)}`),
      }).pipe(Effect.orDie)
    })

    const set = Effect.fn("SessionGoal.set")(function* (sessionID: SessionID, condition: string) {
      const data = yield* InstanceState.get(state)
      data.goals.set(sessionID, { condition, react: 0 })
      yield* persist()
    })

    const get = Effect.fn("SessionGoal.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.goals.get(sessionID)
    })

    const clear = Effect.fn("SessionGoal.clear")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      data.goals.delete(sessionID)
      yield* persist()
    })

    const bumpReact = Effect.fn("SessionGoal.bumpReact")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const current = data.goals.get(sessionID)
      if (!current) return 0
      current.react += 1
      yield* persist()
      return current.react
    })

    const evaluate = Effect.fn("SessionGoal.evaluate")(function* (input: {
      condition: string
      msgs: SessionV1.WithParts[]
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    }) {
      const resolved = yield* provider.getModel(input.model.providerID, input.model.modelID)
      const language = yield* provider.getLanguage(resolved)
      const conversation = yield* MessageV2.toModelMessagesEffect(input.msgs, resolved)
      const authInfo = yield* auth.get(input.model.providerID).pipe(Effect.orDie)
      const isOpenaiOauth = input.model.providerID === "openai" && authInfo?.type === "oauth"
      const schema = Object.assign(
        Schema.toStandardSchemaV1(VerdictSchema),
        Schema.toStandardJSONSchemaV1(VerdictSchema),
      )
      const params = {
        temperature: 0,
        messages: [
          ...(isOpenaiOauth ? [] : [{ role: "system", content: JUDGE_SYSTEM } satisfies ModelMessage]),
          ...conversation,
          {
            role: "user",
            content: `Has this stopping condition been satisfied?\n\nCondition: ${input.condition}`,
          } satisfies ModelMessage,
        ],
        model: language,
        schema,
      } satisfies Parameters<typeof generateObject>[0]

      if (isOpenaiOauth) {
        return yield* Effect.promise(async () => {
          const result = streamObject({
            ...params,
            providerOptions: ProviderTransform.providerOptions(resolved, {
              instructions: JUDGE_SYSTEM,
              store: false,
            }),
            onError: () => {},
          })
          for await (const part of result.fullStream) {
            if (part.type === "error") throw part.error
          }
          return Schema.decodeUnknownSync(VerdictSchema)(await result.object)
        })
      }

      return yield* Effect.promise(() =>
        generateObject(params).then((result) => Schema.decodeUnknownSync(VerdictSchema)(result.object)),
      )
    })

    return Service.of({ set, get, clear, bumpReact, evaluate })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Provider.node, Auth.node] })

export * as SessionGoal from "./goal"
