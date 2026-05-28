// tests/unit/permission-core.test.ts
import { describe, it, expect } from 'vitest'
import { detectHighRisk, normalizePermission, decideDisposition } from '../../src/main/permission-core'
import type { HookEvent } from '../../src/shared/hook-types'

describe('permission-core', () => {
  it('flags destructive Bash payloads', () => {
    expect(detectHighRisk('Bash', 'rm -rf node_modules')?.matched).toBe('rm -rf')
    expect(detectHighRisk('Bash', 'git push --force origin main')?.matched).toBe('git push --force')
    expect(detectHighRisk('Bash', 'sudo apt install x')?.matched).toBe('sudo')
    expect(detectHighRisk('Bash', 'ls -la')).toBeUndefined()
  })
  it('normalizePermission maps a PermissionRequest hook to a PendingPermission', () => {
    const e: HookEvent = { sessionId: 's1', event: 'PermissionRequest', payload: { tool: 'Bash', arguments: 'rm -rf x', reason: 'cleanup', requestId: 'req1' }, ts: 1 }
    const p = normalizePermission(e, { label: 'api-server', provider: 'claude' })
    expect(p.requestId).toBe('req1')
    expect(p.tool).toBe('Bash')
    expect(p.transport).toBe('hook')
    expect(p.highRisk?.matched).toBe('rm -rf')
  })
  it('decideDisposition: high-risk always shows even with a standing approval', () => {
    const p = { tool: 'Bash', payloadPreview: 'rm -rf x', highRisk: { matched: 'rm -rf' } } as any
    expect(decideDisposition(p, () => true)).toBe('show')
  })
  it('decideDisposition: non-high-risk with a matching standing approval auto-allows', () => {
    const p = { tool: 'Bash', payloadPreview: 'ls', highRisk: undefined } as any
    expect(decideDisposition(p, () => true)).toBe('auto-allow')
    expect(decideDisposition(p, () => false)).toBe('show')
  })
  it('does not flag non-Bash tools even when payload looks destructive', () => {
    expect(detectHighRisk('Edit', 'rm -rf node_modules')).toBeUndefined()
    expect(detectHighRisk('Write', 'sudo something')).toBeUndefined()
    expect(detectHighRisk('Read', 'git push --force')).toBeUndefined()
  })
})
