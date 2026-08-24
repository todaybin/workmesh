export * as ComposeEvent from "./compose-event"

import { Compose } from "./compose"
import { Event } from "./event"

export const Updated = Event.define({
  type: "compose.run.updated",
  schema: {
    run: Compose.Info,
  },
})

export const Definitions = Event.inventory(Updated)
