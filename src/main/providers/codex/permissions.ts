/** 'plan' (P3.8, L2 and round 2 PM1): Claude's Plan mode launch option. The
 *  CLI has no launch flag for Plan mode, so a Plan mode session launches
 *  READ-ONLY (the CLI's own sandbox option: no turn can write before Plan mode
 *  is on), and the renderer types the CLI's own /plan into its first ready
 *  prompt. Accepting the plan leaves Plan mode, not read-only: the user
 *  widens what the CLI may do with its own /permissions. */
type Preset = 'read-only' | 'standard' | 'auto' | 'unrestricted' | 'plan'

export function sandboxFor(preset: Preset): 'read-only' | 'workspace-write' | 'danger-full-access' {
  switch (preset) {
    case 'read-only':
    case 'plan': return 'read-only'
    case 'standard':
    case 'auto': return 'workspace-write'
    case 'unrestricted': return 'danger-full-access'
  }
}

export function approvalFor(preset: Preset): 'on-request' | 'never' {
  switch (preset) {
    case 'read-only':
    case 'standard':
    case 'plan': return 'on-request'
    case 'auto':
    case 'unrestricted': return 'never'
  }
}
