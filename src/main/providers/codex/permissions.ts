type Preset = 'read-only' | 'standard' | 'auto' | 'unrestricted'

export function sandboxFor(preset: Preset): 'read-only' | 'workspace-write' | 'danger-full-access' {
  switch (preset) {
    case 'read-only': return 'read-only'
    case 'standard':
    case 'auto': return 'workspace-write'
    case 'unrestricted': return 'danger-full-access'
  }
}

export function approvalFor(preset: Preset): 'on-request' | 'never' {
  switch (preset) {
    case 'read-only':
    case 'standard': return 'on-request'
    case 'auto':
    case 'unrestricted': return 'never'
  }
}
