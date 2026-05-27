// tests/unit/hook-types-channels.test.ts
import { describe, it, expect } from 'vitest'
import { HOOK_EVENT_KINDS } from '../../src/shared/hook-types'

describe('hook-types channels additions', () => {
  it('includes PermissionRequest and FileChanged', () => {
    expect(HOOK_EVENT_KINDS).toContain('PermissionRequest')
    expect(HOOK_EVENT_KINDS).toContain('FileChanged')
  })
})
