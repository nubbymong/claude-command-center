import { describe, it, expect } from 'vitest'
import * as os from 'os'
import { ClaudeProvider } from '../../../../src/main/providers/claude'

describe('ClaudeProvider.resolveBinary', () => {
  it('returns "claude" command on non-Windows', () => {
    if (os.platform() === 'win32') return  // platform-gated; covered by integration on Windows
    const p = new ClaudeProvider()
    const result = p.resolveBinary()
    expect(result).toEqual({ cmd: 'claude', args: [] })
  })

  it('returns a resolved path or "claude" fallback on Windows', () => {
    if (os.platform() !== 'win32') return
    const p = new ClaudeProvider()
    const result = p.resolveBinary()
    expect(result).toBeTruthy()
    expect(typeof result?.cmd).toBe('string')
    expect(result?.cmd.length).toBeGreaterThan(0)
    expect(result?.args).toEqual([])
  })
})
