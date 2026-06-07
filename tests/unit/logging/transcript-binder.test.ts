/**
 * Unit tests for transcript-binder.ts — the single debounced sink that both
 * discovery sources (hooks gateway + statusline watcher) feed.
 *
 * Plain vitest (no native deps): the supervisor surface (bindTranscript) is a
 * stub, canonicalize + the heuristic binder are injected. We assert on the
 * BINDING BEHAVIOUR (what gets bound, at what confidence, when), not on the
 * shape of any mock.
 */
import { describe, it, expect, vi } from 'vitest'
import { makeTranscriptBinder } from '../../../src/main/logging/transcript-binder'
import type { TranscriptBinderDeps } from '../../../src/main/logging/transcript-binder'

interface BindCall {
  sessionId: string
  path: string
  confidence: 'exact' | 'heuristic'
}

/** A controllable fake clock + timer queue so debounce + the 20s fallback are
 *  deterministic. We DON'T use vitest fake timers because the binder is built
 *  with injected setTimer/clearTimer, which is cleaner to drive directly. */
function makeFakeTimers() {
  let nowMs = 0
  let nextId = 1
  const timers = new Map<number, { fireAt: number; cb: () => void }>()
  return {
    now: () => nowMs,
    setTimer: (cb: () => void, ms: number): number => {
      const id = nextId++
      timers.set(id, { fireAt: nowMs + ms, cb })
      return id
    },
    clearTimer: (id: number): void => { timers.delete(id) },
    /** Advance virtual time, firing any timers whose deadline has passed. */
    advance(ms: number): void {
      nowMs += ms
      // Fire in deadline order; copy first so a callback that schedules a new
      // timer doesn't get fired in the same tick.
      const due = [...timers.entries()]
        .filter(([, t]) => t.fireAt <= nowMs)
        .sort((a, b) => a[1].fireAt - b[1].fireAt)
      for (const [id, t] of due) {
        if (timers.has(id)) { timers.delete(id); t.cb() }
      }
    },
    pending: () => timers.size,
  }
}

function makeHarness(overrides?: Partial<TranscriptBinderDeps>) {
  const binds: BindCall[] = []
  const timers = makeFakeTimers()
  // Default canonicalize: strip a leading "junction/" prefix to a "canon/" one so
  // tests can prove canonicalization happened, and return null for non-transcript.
  const canonicalize = vi.fn((p: string): string | null => {
    if (!p.includes('.jsonl')) return null
    return p.replace(/^.*?\.claude\/projects\//, '/home/.claude/projects/')
  })
  const deps: TranscriptBinderDeps = {
    supervisor: { bindTranscript: (sessionId, path, confidence) => { binds.push({ sessionId, path, confidence }) } },
    canonicalize,
    heuristicBinder: { bindOnce: vi.fn(() => null) },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    debounceMs: 100,
    heuristicDelayMs: 20_000,
    ...overrides,
  }
  const binder = makeTranscriptBinder(deps)
  return { binder, binds, timers, canonicalize, deps }
}

describe('transcript-binder — exact path from a discovery source', () => {
  it('canonicalizes then binds with confidence "exact" after the debounce window', () => {
    const { binder, binds, timers } = makeHarness()
    binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/conv.jsonl')
    // Nothing bound until the debounce elapses.
    expect(binds).toHaveLength(0)
    timers.advance(100)
    expect(binds).toEqual([
      { sessionId: 's1', path: '/home/.claude/projects/proj/conv.jsonl', confidence: 'exact' },
    ])
  })

  it('debounces rapid identical paths into a single bind', () => {
    const { binder, binds, timers } = makeHarness()
    binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/conv.jsonl')
    binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/conv.jsonl')
    binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/conv.jsonl')
    timers.advance(100)
    expect(binds).toHaveLength(1)
  })

  it('dedupes an identical already-bound path (no second bind)', () => {
    const { binder, binds, timers } = makeHarness()
    binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/conv.jsonl')
    timers.advance(100)
    expect(binds).toHaveLength(1)
    // Same path arrives again later — already bound, so no new bind.
    binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/conv.jsonl')
    timers.advance(100)
    expect(binds).toHaveLength(1)
  })

  it('rebinds when the same session reports a DIFFERENT path later (/clear rotation)', () => {
    const { binder, binds, timers } = makeHarness()
    binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/first.jsonl')
    timers.advance(100)
    binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/second.jsonl')
    timers.advance(100)
    expect(binds).toEqual([
      { sessionId: 's1', path: '/home/.claude/projects/proj/first.jsonl', confidence: 'exact' },
      { sessionId: 's1', path: '/home/.claude/projects/proj/second.jsonl', confidence: 'exact' },
    ])
  })

  it('ignores a path that canonicalizes to null (non-transcript)', () => {
    const { binder, binds, timers } = makeHarness()
    binder.notifyTranscriptPath('s1', 'C:/some/other/file.txt')
    timers.advance(100)
    expect(binds).toHaveLength(0)
  })

  it('ignores empty/undefined paths without scheduling a bind', () => {
    const { binder, binds, timers } = makeHarness()
    binder.notifyTranscriptPath('s1', '')
    binder.notifyTranscriptPath('s1', undefined as unknown as string)
    timers.advance(100)
    expect(binds).toHaveLength(0)
  })
})

describe('transcript-binder — heuristic fallback', () => {
  it('binds heuristically when a registered run has no exact bind after the delay', () => {
    const heuristicBinder = { bindOnce: vi.fn(() => ({ path: '/home/.claude/projects/proj/heur.jsonl', confidence: 'heuristic' as const })) }
    const { binder, binds, timers } = makeHarness({ heuristicBinder })
    binder.registerRun('s1', 'F:\\proj', 1_000)
    expect(binds).toHaveLength(0)
    timers.advance(20_000)
    expect(heuristicBinder.bindOnce).toHaveBeenCalledWith('s1', 'F:\\proj', 1_000)
    expect(binds).toEqual([
      { sessionId: 's1', path: '/home/.claude/projects/proj/heur.jsonl', confidence: 'heuristic' },
    ])
  })

  it('does NOT fire the heuristic when an exact bind already arrived', () => {
    const heuristicBinder = { bindOnce: vi.fn(() => ({ path: '/home/.claude/projects/proj/heur.jsonl', confidence: 'heuristic' as const })) }
    const { binder, binds, timers } = makeHarness({ heuristicBinder })
    binder.registerRun('s1', 'F:\\proj', 1_000)
    binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/exact.jsonl')
    timers.advance(100)  // exact debounce fires -> binds exact + cancels the heuristic timer
    timers.advance(20_000)
    expect(heuristicBinder.bindOnce).not.toHaveBeenCalled()
    expect(binds).toEqual([
      { sessionId: 's1', path: '/home/.claude/projects/proj/exact.jsonl', confidence: 'exact' },
    ])
  })

  it('does nothing on the heuristic timer when the binder returns null (allows later exact)', () => {
    const heuristicBinder = { bindOnce: vi.fn(() => null) }
    const { binder, binds, timers } = makeHarness({ heuristicBinder })
    binder.registerRun('s1', 'F:\\proj', 1_000)
    timers.advance(20_000)
    expect(binds).toHaveLength(0)
    // A real exact bind STILL works afterwards.
    binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/exact.jsonl')
    timers.advance(100)
    expect(binds).toEqual([
      { sessionId: 's1', path: '/home/.claude/projects/proj/exact.jsonl', confidence: 'exact' },
    ])
  })

  it('endRun cancels a pending heuristic timer', () => {
    const heuristicBinder = { bindOnce: vi.fn(() => ({ path: '/home/.claude/projects/proj/heur.jsonl', confidence: 'heuristic' as const })) }
    const { binder, binds, timers } = makeHarness({ heuristicBinder })
    binder.registerRun('s1', 'F:\\proj', 1_000)
    binder.endRun('s1')
    timers.advance(20_000)
    expect(heuristicBinder.bindOnce).not.toHaveBeenCalled()
    expect(binds).toHaveLength(0)
  })
})

describe('transcript-binder — exact supersedes heuristic', () => {
  it('a later exact bind replaces a session that only had a heuristic bind', () => {
    const heuristicBinder = { bindOnce: vi.fn(() => ({ path: '/home/.claude/projects/proj/heur.jsonl', confidence: 'heuristic' as const })) }
    const { binder, binds, timers } = makeHarness({ heuristicBinder })
    binder.registerRun('s1', 'F:\\proj', 1_000)
    timers.advance(20_000)   // heuristic binds
    expect(binds).toEqual([
      { sessionId: 's1', path: '/home/.claude/projects/proj/heur.jsonl', confidence: 'heuristic' },
    ])
    // Now an exact path arrives — must supersede the heuristic, even though it
    // canonicalizes to a DIFFERENT path.
    binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/exact.jsonl')
    timers.advance(100)
    expect(binds).toEqual([
      { sessionId: 's1', path: '/home/.claude/projects/proj/heur.jsonl', confidence: 'heuristic' },
      { sessionId: 's1', path: '/home/.claude/projects/proj/exact.jsonl', confidence: 'exact' },
    ])
  })

  it('an exact bind matching the heuristic path still upgrades confidence to exact', () => {
    const samePath = '/home/.claude/projects/proj/conv.jsonl'
    const heuristicBinder = { bindOnce: vi.fn(() => ({ path: samePath, confidence: 'heuristic' as const })) }
    const canonicalize = vi.fn(() => samePath)
    const { binder, binds, timers } = makeHarness({ heuristicBinder, canonicalize })
    binder.registerRun('s1', 'F:\\proj', 1_000)
    timers.advance(20_000)
    binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/conv.jsonl')
    timers.advance(100)
    expect(binds).toEqual([
      { sessionId: 's1', path: samePath, confidence: 'heuristic' },
      { sessionId: 's1', path: samePath, confidence: 'exact' },
    ])
  })
})

describe('transcript-binder — getLatestTranscriptPath (for T8b resume)', () => {
  it('returns null before any bind', () => {
    const { binder } = makeHarness()
    expect(binder.getLatestTranscriptPath('s1')).toBeNull()
  })

  it('returns the canonical path after an exact bind', () => {
    const { binder, timers } = makeHarness()
    binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/conv.jsonl')
    timers.advance(100)
    expect(binder.getLatestTranscriptPath('s1')).toBe('/home/.claude/projects/proj/conv.jsonl')
  })

  it('returns the heuristic path after a heuristic bind, then updates to exact', () => {
    const heuristicBinder = { bindOnce: vi.fn(() => ({ path: '/home/.claude/projects/proj/heur.jsonl', confidence: 'heuristic' as const })) }
    const { binder, timers } = makeHarness({ heuristicBinder })
    binder.registerRun('s1', 'F:\\proj', 1_000)
    timers.advance(20_000)
    expect(binder.getLatestTranscriptPath('s1')).toBe('/home/.claude/projects/proj/heur.jsonl')
    binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/exact.jsonl')
    timers.advance(100)
    expect(binder.getLatestTranscriptPath('s1')).toBe('/home/.claude/projects/proj/exact.jsonl')
  })

  it('reflects the latest path after a rebind', () => {
    const { binder, timers } = makeHarness()
    binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/first.jsonl')
    timers.advance(100)
    binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/second.jsonl')
    timers.advance(100)
    expect(binder.getLatestTranscriptPath('s1')).toBe('/home/.claude/projects/proj/second.jsonl')
  })
})

describe('transcript-binder — sessionId reuse across restarts', () => {
  it('endRun clears bound state so a reused sessionId can bind fresh', () => {
    const { binder, binds, timers } = makeHarness()
    binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/conv.jsonl')
    timers.advance(100)
    expect(binds).toHaveLength(1)
    binder.endRun('s1')
    expect(binder.getLatestTranscriptPath('s1')).toBeNull()
    // Same sessionId, same path after restart -> must bind again (not deduped).
    binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/conv.jsonl')
    timers.advance(100)
    expect(binds).toHaveLength(2)
  })
})
