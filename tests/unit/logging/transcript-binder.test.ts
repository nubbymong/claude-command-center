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
    heuristicBinder: { bindOnce: vi.fn(() => null), forget: vi.fn() },
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
    const heuristicBinder = { bindOnce: vi.fn(() => ({ path: '/home/.claude/projects/proj/heur.jsonl', confidence: 'heuristic' as const })), forget: vi.fn() }
    const { binder, binds, timers } = makeHarness({ heuristicBinder })
    binder.registerRun('s1', 'F:\\proj', 1_000)
    expect(binds).toHaveLength(0)
    timers.advance(20_000)
    // #480: the binder now also passes the set of uuids owned by other live
    // sessions so the scan can skip them (empty here — no other exact owner).
    expect(heuristicBinder.bindOnce).toHaveBeenCalledWith('s1', 'F:\\proj', 1_000, expect.any(Set))
    expect(binds).toEqual([
      { sessionId: 's1', path: '/home/.claude/projects/proj/heur.jsonl', confidence: 'heuristic' },
    ])
  })

  it('does NOT fire the heuristic when an exact bind already arrived', () => {
    const heuristicBinder = { bindOnce: vi.fn(() => ({ path: '/home/.claude/projects/proj/heur.jsonl', confidence: 'heuristic' as const })), forget: vi.fn() }
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
    const heuristicBinder = { bindOnce: vi.fn(() => null), forget: vi.fn() }
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
    const heuristicBinder = { bindOnce: vi.fn(() => ({ path: '/home/.claude/projects/proj/heur.jsonl', confidence: 'heuristic' as const })), forget: vi.fn() }
    const { binder, binds, timers } = makeHarness({ heuristicBinder })
    binder.registerRun('s1', 'F:\\proj', 1_000)
    binder.endRun('s1')
    timers.advance(20_000)
    expect(heuristicBinder.bindOnce).not.toHaveBeenCalled()
    expect(binds).toHaveLength(0)
  })
})

describe('transcript-binder — heuristic retry safety net', () => {
  it('re-arms the heuristic when bindOnce returns null, then binds on a later attempt', () => {
    // bindOnce returns null on the first two fires, then finds the transcript.
    let calls = 0
    const bindOnce = vi.fn(() => {
      calls += 1
      return calls >= 3
        ? { path: '/home/.claude/projects/proj/late.jsonl', confidence: 'heuristic' as const }
        : null
    })
    const heuristicBinder = { bindOnce, forget: vi.fn() }
    const { binder, binds, timers } = makeHarness({ heuristicBinder })
    binder.registerRun('s1', 'F:\\proj', 1_000)

    // First fire: null -> re-arm, nothing bound.
    timers.advance(20_000)
    expect(binds).toHaveLength(0)
    expect(bindOnce).toHaveBeenCalledTimes(1)
    expect(timers.pending()).toBeGreaterThan(0)   // a retry timer is armed

    // Second fire: still null -> re-arm.
    timers.advance(20_000)
    expect(binds).toHaveLength(0)
    expect(bindOnce).toHaveBeenCalledTimes(2)

    // Third fire: found -> binds heuristic.
    timers.advance(20_000)
    expect(bindOnce).toHaveBeenCalledTimes(3)
    expect(binds).toEqual([
      { sessionId: 's1', path: '/home/.claude/projects/proj/late.jsonl', confidence: 'heuristic' },
    ])
  })

  it('stops retrying after the cap (initial fire + retryCap attempts)', () => {
    const bindOnce = vi.fn(() => null)
    const heuristicBinder = { bindOnce, forget: vi.fn() }
    // retryCap=3 -> 1 initial + 3 retries = 4 total bindOnce calls.
    const { binder, binds, timers } = makeHarness({ heuristicBinder, heuristicRetryCap: 3 })
    binder.registerRun('s1', 'F:\\proj', 1_000)
    for (let i = 0; i < 10; i++) timers.advance(20_000)
    expect(bindOnce).toHaveBeenCalledTimes(4)
    expect(binds).toHaveLength(0)
    expect(timers.pending()).toBe(0)   // no more timers armed after the cap
  })

  it('an exact bind that arrives during retries supersedes and stops re-arming', () => {
    const bindOnce = vi.fn(() => null)
    const heuristicBinder = { bindOnce, forget: vi.fn() }
    const { binder, binds, timers } = makeHarness({ heuristicBinder, heuristicRetryCap: 5 })
    binder.registerRun('s1', 'F:\\proj', 1_000)
    timers.advance(20_000)   // first heuristic fire -> null -> re-arm
    expect(bindOnce).toHaveBeenCalledTimes(1)
    // Exact bind arrives now -> cancels the pending retry timer.
    binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/exact.jsonl')
    timers.advance(100)
    expect(binds).toEqual([
      { sessionId: 's1', path: '/home/.claude/projects/proj/exact.jsonl', confidence: 'exact' },
    ])
    // No further heuristic attempts after the exact bind.
    timers.advance(20_000)
    timers.advance(20_000)
    expect(bindOnce).toHaveBeenCalledTimes(1)
  })

  it('endRun cancels a pending retry timer (no further bindOnce calls)', () => {
    const bindOnce = vi.fn(() => null)
    const heuristicBinder = { bindOnce, forget: vi.fn() }
    const { binder, timers } = makeHarness({ heuristicBinder, heuristicRetryCap: 5 })
    binder.registerRun('s1', 'F:\\proj', 1_000)
    timers.advance(20_000)   // first fire -> null -> re-arm
    expect(bindOnce).toHaveBeenCalledTimes(1)
    binder.endRun('s1')
    timers.advance(20_000)
    timers.advance(20_000)
    expect(bindOnce).toHaveBeenCalledTimes(1)   // endRun cancelled the retry
  })
})

describe('transcript-binder — diagnostics (injected log)', () => {
  it('logs registerRun, exact bind committed, and a canonicalize-null', () => {
    const log = vi.fn()
    const { binder, timers } = makeHarness({ log })
    binder.registerRun('s1', 'F:\\proj', 1_000)
    expect(log.mock.calls.flat().some((m) => /registerRun/.test(String(m)) && String(m).includes('s1'))).toBe(true)

    binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/conv.jsonl')
    timers.advance(100)
    expect(log.mock.calls.flat().some((m) => /exact bind/i.test(String(m)) && String(m).includes('/home/.claude/projects/proj/conv.jsonl'))).toBe(true)

    log.mockClear()
    binder.notifyTranscriptPath('s2', 'C:/some/other/file.txt')
    timers.advance(100)
    expect(log.mock.calls.flat().some((m) => /canonicalize/i.test(String(m)))).toBe(true)
  })

  it('logs the heuristic fire and its result (found|null)', () => {
    const log = vi.fn()
    const heuristicBinder = { bindOnce: vi.fn(() => ({ path: '/home/.claude/projects/proj/heur.jsonl', confidence: 'heuristic' as const })), forget: vi.fn() }
    const { binder, timers } = makeHarness({ log, heuristicBinder })
    binder.registerRun('s1', 'F:\\proj', 1_000)
    timers.advance(20_000)
    expect(log.mock.calls.flat().some((m) => /heuristic/i.test(String(m)))).toBe(true)
  })

  it('defaults to a no-op log (no throw when log is not injected)', () => {
    const { binder, timers } = makeHarness({ log: undefined })
    expect(() => {
      binder.registerRun('s1', 'F:\\proj', 1_000)
      binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/conv.jsonl')
      timers.advance(100)
    }).not.toThrow()
  })
})

describe('transcript-binder — exact supersedes heuristic', () => {
  it('a later exact bind replaces a session that only had a heuristic bind', () => {
    const heuristicBinder = { bindOnce: vi.fn(() => ({ path: '/home/.claude/projects/proj/heur.jsonl', confidence: 'heuristic' as const })), forget: vi.fn() }
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
    const heuristicBinder = { bindOnce: vi.fn(() => ({ path: samePath, confidence: 'heuristic' as const })), forget: vi.fn() }
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
    const heuristicBinder = { bindOnce: vi.fn(() => ({ path: '/home/.claude/projects/proj/heur.jsonl', confidence: 'heuristic' as const })), forget: vi.fn() }
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

  it('endRun forgets the heuristic cache so a restart rebinds the FRESH heuristic path', () => {
    // Model the heuristic binder's permanent successCache: bindOnce returns
    // path A until forget(sessionId) is called, after which it returns path B.
    let forgotten = false
    const forget = vi.fn((_sessionId: string) => { forgotten = true })
    const bindOnce = vi.fn(() =>
      forgotten
        ? { path: '/home/.claude/projects/proj/run2.jsonl', confidence: 'heuristic' as const }
        : { path: '/home/.claude/projects/proj/run1.jsonl', confidence: 'heuristic' as const },
    )
    const heuristicBinder = { bindOnce, forget }
    const { binder, binds, timers } = makeHarness({ heuristicBinder })

    // Run #1: register, heuristic fires, binds the stale run1 path.
    binder.registerRun('s1', 'F:\\proj', 1_000)
    timers.advance(20_000)
    expect(binds).toEqual([
      { sessionId: 's1', path: '/home/.claude/projects/proj/run1.jsonl', confidence: 'heuristic' },
    ])

    // Restart reuses the same sessionId. endRun MUST forget the heuristic cache.
    binder.endRun('s1')
    expect(forget).toHaveBeenCalledWith('s1')

    // Run #2: same sessionId, heuristic fires again — must rescan and bind the
    // FRESH run2 path, not the stale cached run1 path.
    binder.registerRun('s1', 'F:\\proj', 2_000)
    timers.advance(20_000)
    expect(binds).toEqual([
      { sessionId: 's1', path: '/home/.claude/projects/proj/run1.jsonl', confidence: 'heuristic' },
      { sessionId: 's1', path: '/home/.claude/projects/proj/run2.jsonl', confidence: 'heuristic' },
    ])
  })
})

describe('transcript-binder — registerRun re-bind on restart (no endRun)', () => {
  /**
   * The confirmed live bug: a session restarts into the same transcript path.
   * pty-manager's `weAreCurrent` guard means endRun never fires on the restart
   * exit, so SessionState persists across runs. When the new run's resume-bind
   * calls notifyTranscriptPath(samePath), commitExact deduped it against the
   * still-set boundPath from run 1 and skipped bindTranscript → nt=0, no logs.
   *
   * Fix: registerRun resets boundPath + boundConfidence (+ clears any stale
   * debounce) so the next notify is treated as a fresh bind.
   */

  it('registerRun resets bind state so a restart into the same path re-binds', () => {
    const { binder, binds, timers } = makeHarness()

    // Run 1: exact bind settles.
    binder.registerRun('s1', 'F:\\proj', 1_000)
    binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/conv.jsonl')
    timers.advance(100)
    expect(binds).toHaveLength(1)
    expect(binder.getLatestTranscriptPath('s1')).toBe('/home/.claude/projects/proj/conv.jsonl')

    // Simulate restart: registerRun again (no endRun), same sessionId.
    binder.registerRun('s1', 'F:\\proj', 2_000)

    // After registerRun the latest path is null (state was reset).
    expect(binder.getLatestTranscriptPath('s1')).toBeNull()

    // Resume-bind sends the SAME path for run 2 → must NOT be deduped.
    binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/conv.jsonl')
    timers.advance(100)
    expect(binds).toHaveLength(2)   // <-- was 1 (deduped) before the fix
    expect(binds[1]).toEqual({
      sessionId: 's1',
      path: '/home/.claude/projects/proj/conv.jsonl',
      confidence: 'exact',
    })
  })

  it('within-run dedupe is intact: a second notify of the same path in the SAME run does NOT re-bind', () => {
    const { binder, binds, timers } = makeHarness()

    binder.registerRun('s1', 'F:\\proj', 1_000)
    // First notify in run 1 → binds.
    binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/conv.jsonl')
    timers.advance(100)
    expect(binds).toHaveLength(1)

    // Second notify in the SAME run with the same path → deduped.
    binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/conv.jsonl')
    timers.advance(100)
    expect(binds).toHaveLength(1)   // still 1 — within-run dedupe intact
  })

  it('getLatestTranscriptPath returns null immediately after registerRun (before re-bind)', () => {
    const { binder, timers } = makeHarness()

    // Bind in run 1.
    binder.registerRun('s1', 'F:\\proj', 1_000)
    binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/conv.jsonl')
    timers.advance(100)
    expect(binder.getLatestTranscriptPath('s1')).toBe('/home/.claude/projects/proj/conv.jsonl')

    // Restart (no endRun): registerRun must clear the latest path immediately.
    binder.registerRun('s1', 'F:\\proj', 2_000)
    expect(binder.getLatestTranscriptPath('s1')).toBeNull()

    // Re-bind restores it.
    binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/conv.jsonl')
    timers.advance(100)
    expect(binder.getLatestTranscriptPath('s1')).toBe('/home/.claude/projects/proj/conv.jsonl')
  })

  it('a pending debounce from run 1 is cleared by registerRun so it cannot pollute run 2', () => {
    const { binder, binds, timers } = makeHarness()

    binder.registerRun('s1', 'F:\\proj', 1_000)
    // Notify but do NOT advance timers — debounce is still pending.
    binder.notifyTranscriptPath('s1', 'F:/junction/.claude/projects/proj/conv.jsonl')
    expect(binds).toHaveLength(0)

    // registerRun fires before the debounce settles.
    binder.registerRun('s1', 'F:\\proj', 2_000)

    // Now advance: the stale debounce must NOT fire.
    timers.advance(100)
    expect(binds).toHaveLength(0)  // cleared by registerRun, nothing to commit
  })
})
