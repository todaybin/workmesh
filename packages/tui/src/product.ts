declare const WORKMESH_BUILD: boolean | undefined

const enabled = typeof WORKMESH_BUILD === "boolean" ? WORKMESH_BUILD : process.env.WORKMESH_BUILD === "1"

export const TuiProduct = {
  enabled,
  displayName: enabled ? "WorkMesh" : "OpenCode",
  cliName: enabled ? "workmesh" : "opencode",
  defaultTheme: enabled ? "workmesh" : "opencode",
} as const
