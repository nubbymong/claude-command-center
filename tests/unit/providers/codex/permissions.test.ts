import { describe, it, expect } from 'vitest'
import { sandboxFor, approvalFor } from '../../../../src/main/providers/codex/permissions'

describe('codex permissions preset mapping', () => {
  it.each([
    ['read-only',    'read-only',          'on-request'],
    ['standard',     'workspace-write',    'on-request'],
    ['auto',         'workspace-write',    'never'],
    ['unrestricted', 'danger-full-access', 'never'],
  ])('%s -> sandbox=%s, approval=%s', (preset, sandbox, approval) => {
    expect(sandboxFor(preset as any)).toBe(sandbox)
    expect(approvalFor(preset as any)).toBe(approval)
  })
})
