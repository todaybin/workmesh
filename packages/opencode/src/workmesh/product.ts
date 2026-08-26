declare const OPENCODE_CLI_NAME: string | undefined
declare const WORKMESH_BUILD: boolean | undefined

const enabled = () => (typeof WORKMESH_BUILD === "boolean" ? WORKMESH_BUILD : process.env.WORKMESH_BUILD === "1")

export const WorkMeshProduct = {
  get enabled() {
    return enabled()
  },
  get cliName() {
    return (
      (enabled() ? process.env.WORKMESH_CLI_NAME : undefined) ??
      (typeof OPENCODE_CLI_NAME === "string" ? OPENCODE_CLI_NAME : "opencode")
    )
  },
  get displayName() {
    return enabled() ? "WorkMesh" : "OpenCode"
  },
}
