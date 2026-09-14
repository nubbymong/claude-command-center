import { describe, it, expect } from 'vitest'
import { resolveHooksPort, DEFAULT_HOOKS_PORT, DEV_HOOKS_PORT } from '../../../src/main/hooks/hooks-types'

// A dev instance must run alongside a live prod install, so the default hooks
// port is split by build mode (like MCP 19433/19333 and CDP 9322/9222).
describe('resolveHooksPort', () => {
  it('prod (packaged) uses 19334', () => {
    expect(resolveHooksPort(true)).toBe(DEFAULT_HOOKS_PORT)
    expect(DEFAULT_HOOKS_PORT).toBe(19334)
  })

  it('dev (unpackaged) uses 19434 so it never collides with prod', () => {
    expect(resolveHooksPort(false)).toBe(DEV_HOOKS_PORT)
    expect(DEV_HOOKS_PORT).toBe(19434)
  })

  it('dev and prod ports differ', () => {
    expect(resolveHooksPort(false)).not.toBe(resolveHooksPort(true))
  })
})
