// tests/unit/effort-tracker.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

const sent: Array<{ channel: string; payload: unknown }> = []
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } }],
  },
}))
vi.mock('../../src/main/hooks/index', () => ({ getGateway: () => null }))

import { effortFromEvent, _emitForTest, _resetEffort } from '../../src/main/effort-tracker'
import type { HookEvent } from '../../src/shared/hook-types'

const ev = (over: Partial<HookEvent>): HookEvent => ({
  sessionId: 's1', event: 'PreToolUse', payload: {}, ts: 1, ...over,
})

describe('effortFromEvent', () => {
  it('reads a valid level from payload.effort.level', () => {
    expect(effortFromEvent(ev({ payload: { effort: { level: 'xhigh' } } }))).toBe('xhigh')
  })
  it('returns undefined for missing or invalid levels', () => {
    expect(effortFromEvent(ev({ payload: {} }))).toBeUndefined()
    expect(effortFromEvent(ev({ payload: { effort: { level: 'bogus' } } }))).toBeUndefined()
    expect(effortFromEvent(ev({ payload: { effort: 'xhigh' } }))).toBeUndefined()
  })
})

describe('effort push + dedupe', () => {
  beforeEach(() => { sent.length = 0; _resetEffort() })
  it('pushes on first valid event and dedupes repeats', () => {
    _emitForTest(ev({ payload: { effort: { level: 'high' } } }))
    _emitForTest(ev({ payload: { effort: { level: 'high' } } }))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({ channel: 'hooks:effortUpdate', payload: { sessionId: 's1', effortLevel: 'high' } })
  })
  it('pushes again when the level changes', () => {
    _emitForTest(ev({ payload: { effort: { level: 'high' } } }))
    _emitForTest(ev({ payload: { effort: { level: 'xhigh' } } }))
    expect(sent).toHaveLength(2)
  })
  it('ignores events with no sessionId', () => {
    _emitForTest(ev({ sessionId: '', payload: { effort: { level: 'high' } } }))
    expect(sent).toHaveLength(0)
  })
})
