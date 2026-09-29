/** 'plan' (P3.8 round 1, L2): Claude's Plan mode launch option. The CLI has no
 *  launch flag for Plan mode, so a Plan mode session launches with Standard's
 *  sandbox and approvals (what applies once the plan is accepted and the CLI
 *  leaves Plan mode), and the renderer types the CLI's own /plan once its
 *  composer is ready. */
type Preset = 'read-only' | 'standard' | 'auto' | 'unrestricted' | 'plan'

export function sandboxFor(preset: Preset): 'read-only' | 'workspace-write' | 'danger-full-access' {
  switch (preset) {
    case 'read-only': return 'read-only'
    case 'standard':
    case 'plan':
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
