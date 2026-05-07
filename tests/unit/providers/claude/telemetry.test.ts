import { describe, it, expect, vi } from 'vitest'
import { ClaudeProvider } from '../../../../src/main/providers/claude'
import { notifyClaudeTelemetry } from '../../../../src/main/providers/claude/telemetry'
import type { StatuslineData } from '../../../../src/shared/types'

describe('ClaudeProvider.ingestSessionTelemetry', () => {
  it('returns a TelemetrySource with stop()', () => {
    const p = new ClaudeProvider()
    const src = p.ingestSessionTelemetry('sid-tel-1', { cwd: '/test', spawnTimestamp: Date.now() }, () => { /* noop */ })
    expect(src).toBeTruthy()
    expect(typeof src.stop).toBe('function')
    src.stop()  // should not throw
  })

  it('routes notifications by session id and respects unsubscribe', () => {
    const p = new ClaudeProvider()
    const cb = vi.fn()
    const src = p.ingestSessionTelemetry('sid-tel-2', { cwd: '/test', spawnTimestamp: Date.now() }, cb)

    const data: StatuslineData = { sessionId: 'sid-tel-2', timestamp: Date.now() } as StatuslineData
    notifyClaudeTelemetry(data)
    expect(cb).toHaveBeenCalledTimes(1)

    // Different session id is filtered out
    notifyClaudeTelemetry({ sessionId: 'sid-other', timestamp: Date.now() } as StatuslineData)
    expect(cb).toHaveBeenCalledTimes(1)

    // After stop(), no further calls
    src.stop()
    notifyClaudeTelemetry(data)
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
