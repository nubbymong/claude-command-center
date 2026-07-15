// tests/unit/effort-tracker.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

const sent: Array<{ channel: string; payload: unknown }> = []
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } }],
  },
}))
vi.mock('../../src/main/hooks/index', () => ({ getGateway: () => null }))
vi.mock('../../src/main/model-registry-service', () => ({
  getRegistry: () => ({
    effortLevels: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra high' },
      { value: 'max', label: 'Max' },
      { value: 'ultracode', label: 'Ultracode' },
    ],
  }),
}))

import { effortFromEvent, _emitForTest, _resetEffort, _setEffortObserverForTest } from '../../src/main/effort-tracker'
import { _resetBackgroundContextForTest } from '../../src/main/background-context'
import type { HookEvent } from '../../src/shared/hook-types'

const ev = (over: Partial<HookEvent>): HookEvent => ({
  sessionId: 's1', event: 'PreToolUse', payload: {}, ts: 1, ...over,
})

describe('effortFromEvent', () => {
  it('reads a valid level from payload.effort.level', () => {
    expect(effortFromEvent(ev({ payload: { effort: { level: 'xhigh' } } }))).toBe('xhigh')
  })
  it('returns the level string even for unknown levels (permissive contract)', () => {
    expect(effortFromEvent(ev({ payload: {} }))).toBeUndefined()
    expect(effortFromEvent(ev({ payload: { effort: { level: 'bogus' } } }))).toBe('bogus')
    expect(effortFromEvent(ev({ payload: { effort: 'xhigh' } }))).toBeUndefined()
  })
})

describe('effort push + dedupe', () => {
  beforeEach(() => { sent.length = 0; _resetEffort(); _resetBackgroundContextForTest(); _setEffortObserverForTest(null) })
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
  it('clears per-session state on Stop so a later same-level event pushes again', () => {
    _emitForTest(ev({ payload: { effort: { level: 'high' } } }))
    _emitForTest(ev({ event: 'Stop', payload: {} }))
    _emitForTest(ev({ payload: { effort: { level: 'high' } } }))
    expect(sent).toHaveLength(2)
  })
})

describe('effort gating — subagents + dynamic-workflow agents must not repaint the main strip', () => {
  beforeEach(() => { sent.length = 0; _resetEffort(); _resetBackgroundContextForTest(); _setEffortObserverForTest(null) })

  it('suppresses effort from a subagent (bracketed by SubagentStart/Stop)', () => {
    _emitForTest(ev({ payload: { effort: { level: 'high' } } }))       // main
    _emitForTest(ev({ event: 'SubagentStart', payload: {} }))
    _emitForTest(ev({ payload: { effort: { level: 'xhigh' } } }))      // subagent — must be ignored
    _emitForTest(ev({ event: 'SubagentStop', payload: {} }))
    // Only the main-thread 'high' pushed; the subagent 'xhigh' was gated.
    expect(sent).toEqual([{ channel: 'hooks:effortUpdate', payload: { sessionId: 's1', effortLevel: 'high' } }])
  })

  it('resumes pushing the main effort after the subagent finishes', () => {
    _emitForTest(ev({ event: 'SubagentStart', payload: {} }))
    _emitForTest(ev({ payload: { effort: { level: 'xhigh' } } }))      // subagent — ignored
    _emitForTest(ev({ event: 'SubagentStop', payload: {} }))
    _emitForTest(ev({ payload: { effort: { level: 'max' } } }))        // back on the main thread
    expect(sent).toEqual([{ channel: 'hooks:effortUpdate', payload: { sessionId: 's1', effortLevel: 'max' } }])
  })

  it('suppresses effort from a dynamic-workflow agent via transcript mismatch (no SubagentStart)', () => {
    const MAIN = '/p/main.jsonl'
    const AGENT = '/p/agent.jsonl'
    _emitForTest(ev({ event: 'SessionStart', payload: { transcript_path: MAIN } }))
    _emitForTest(ev({ payload: { effort: { level: 'high' }, transcript_path: MAIN } }))   // main
    _emitForTest(ev({ payload: { effort: { level: 'xhigh' }, transcript_path: AGENT } })) // workflow agent — gated
    expect(sent).toEqual([{ channel: 'hooks:effortUpdate', payload: { sessionId: 's1', effortLevel: 'high' } }])
  })
})

describe('effort observer seam (Sentinel Trigger A)', () => {
  beforeEach(() => { sent.length = 0; _resetEffort(); _setEffortObserverForTest(null) })

  it('accepts an unknown effort level and reports it via the observe hook (spec: Layer 1 + Trigger A)', () => {
    const seen: string[] = []
    _setEffortObserverForTest((value) => seen.push(value))
    _emitForTest({ event: 'PreToolUse', sessionId: 's1', payload: { effort: { level: 'theoretical' } } } as never)
    expect(seen).toEqual(['theoretical'])
  })

  it('still pushes a registry-known effort and does NOT observe it', () => {
    const seen: string[] = []
    _setEffortObserverForTest((value) => seen.push(value))
    _emitForTest({ event: 'PreToolUse', sessionId: 's2', payload: { effort: { level: 'xhigh' } } } as never)
    expect(seen).toEqual([])
  })

  it('pushes an unknown effort level to the renderer like a known one', () => {
    _emitForTest({ event: 'PreToolUse', sessionId: 's3', payload: { effort: { level: 'theoretical' } } } as never)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({ channel: 'hooks:effortUpdate', payload: { sessionId: 's3', effortLevel: 'theoretical' } })
  })

  it('does not let an observer error break effort tracking', () => {
    _setEffortObserverForTest(() => { throw new Error('observer boom') })
    _emitForTest({ event: 'PreToolUse', sessionId: 's4', payload: { effort: { level: 'theoretical' } } } as never)
    // pushEffort must still fire
    expect(sent).toHaveLength(1)
  })
})
