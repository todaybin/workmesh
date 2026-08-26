import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260814045027_massive_outlaw_kid",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`workmesh_terminal_message\` ADD \`execution\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
