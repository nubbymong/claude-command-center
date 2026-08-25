/**
 * #480 — durable, cross-safe session→conversation binding.
 *
 * These tests cover the three guarantees added to the binder so two cards
 * sharing one repo folder can never resume each other's conversation:
 *   1. exact-only resume target (getExactResumeTarget) — a heuristic bind is
 *      NOT a resume source;
 *   2. an ownership guard — one conversation uuid belongs to at most one LIVE
 *      session; a second live session cannot steal it;
 *   3. the heuristic scan is told which uuids other live sessions own, and the
 *      durable `persist` sink fires on every exact bind.
 *
 * Plain vitest (no native deps): supervisor / heuristic binder / persist are
 * stubs; canonicalize is injected. Paths are already-canonical and end in a real
 * UUID so the binder's uuid extraction activates.
 */
import { describe, it, expect, vi } from 'vitest'
import { makeTranscriptBinder } from '../../../src/main/logging/transcript-binder'
import type { TranscriptBinderDeps, TranscriptHeuristicBinder } from '../../../src/main/logging/transcript-binder'
import type { DiscoveryBinding } from '../../../src/main/logging/transcript-discovery'

const UUID_X = '11111111-1111-4111-8111-111111111111'
const UUID_Y = '22222222-2222-4222-8222-222222222222'
const pathFor = (uuid: string) => `/home/.claude/projects/proj/${uuid}.jsonl`

interface BindCall { sessionId: string; path: string; confidence: 'exact' | 'heuristic' }
interface PersistCall { sessionId: string; path: string; uuid: string }

function makeFakeTimers() {
  let nowMs = 0
  let nextId = 1
  const timers = new Map<number, { fireAt: number; cb: () => void }>()
  return {
    setTimer: (cb: () => void, ms: number): number => { const id = nextId++; timers.set(id, { fireAt: nowMs + ms, cb }); return id },
    clearTimer: (id: number): void => { timers.delete(id) },
    advance(ms: number): void {
      nowMs += ms
      const due = [...timers.entries()].filter(([, t]) => t.fireAt <= nowMs).sort((a, b) => a[1].fireAt - b[1].fireAt)
      for (const [id, t] of due) if (timers.has(id)) { timers.delete(id); t.cb() }
    },
  }
}

/** A heuristic binder whose result is scripted per call and that records the
 *  excludeUuids set it was handed. */
function makeScriptedHeuristic(result: (cwd: string) => DiscoveryBinding | null) {
  const calls: Array<{ sessionId: string; exclude: ReadonlySet<string> | undefined }> = []
  const hb: TranscriptHeuristicBinder = {
    bindOnce: vi.fn((sessionId, cwd, _startedAtMs, exclude) => {
      calls.push({ sessionId, exclude })
      return result(cwd)
    }),
    forget: vi.fn(),
  }
  return { hb, calls }
}

function makeHarness(overrides?: Partial<TranscriptBinderDeps>) {
  const binds: BindCall[] = []
  const persists: PersistCall[] = []
  const timers = makeFakeTimers()
  const deps: TranscriptBinderDeps = {
    supervisor: { bindTranscript: (sessionId, path, confidence) => { binds.push({ sessionId, path, confidence }) } },
    canonicalize: (p: string) => (p.includes('.jsonl') ? p : null),
    heuristicBinder: { bindOnce: vi.fn(() => null), forget: vi.fn() },
    persist: (sessionId, path, uuid) => { persists.push({ sessionId, path, uuid }) },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    debounceMs: 100,
    heuristicDelayMs: 20_000,
    ...overrides,
  }
  const binder = makeTranscriptBinder(deps)
  return { binder, binds, persists, timers }
}

describe('#480 exact-only resume target', () => {
  it('exposes an exact bind via getExactResumeTarget', () => {
    const { binder, timers } = makeHarness()
    binder.notifyTranscriptPath('s1', pathFor(UUID_X))
    timers.advance(100)
    expect(binder.getExactResumeTarget('s1')).toBe(pathFor(UUID_X))
    expect(binder.getLatestTranscriptPath('s1')).toBe(pathFor(UUID_X))
  })

  it('does NOT expose a heuristic bind as a resume target', () => {
    const heuristic = makeScriptedHeuristic(() => ({ path: pathFor(UUID_X), confidence: 'heuristic' }))
    const { binder, timers } = makeHarness({ heuristicBinder: heuristic.hb })
    binder.registerRun('s1', '/repo', 0)
    timers.advance(20_000) // fire the heuristic fallback
    // Latest path is the heuristic one, but it is NOT an exact resume source.
    expect(binder.getLatestTranscriptPath('s1')).toBe(pathFor(UUID_X))
    expect(binder.getExactResumeTarget('s1')).toBeNull()
  })

  it('persists the durable record on every exact bind', () => {
    const { binder, persists, timers } = makeHarness()
    binder.notifyTranscriptPath('s1', pathFor(UUID_X))
    timers.advance(100)
    expect(persists).toEqual([{ sessionId: 's1', path: pathFor(UUID_X), uuid: UUID_X }])
  })
})

describe('#480 ownership guard — one conversation, one live session', () => {
  it('refuses a second LIVE session from stealing a bound conversation', () => {
    const { binder, binds, persists, timers } = makeHarness()
    // s1 binds conversation X.
    binder.registerRun('s1', '/repo', 0)
    binder.notifyTranscriptPath('s1', pathFor(UUID_X))
    timers.advance(100)
    // s2 (also live) tries to bind the SAME conversation X.
    binder.registerRun('s2', '/repo', 0)
    binder.notifyTranscriptPath('s2', pathFor(UUID_X))
    timers.advance(100)
    // s2 is refused: no bind, no persist, no resume target.
    expect(binder.getExactResumeTarget('s2')).toBeNull()
    expect(binds.filter((b) => b.sessionId === 's2')).toHaveLength(0)
    expect(persists.filter((p) => p.sessionId === 's2')).toHaveLength(0)
    // s1 keeps ownership.
    expect(binder.getExactResumeTarget('s1')).toBe(pathFor(UUID_X))
  })

  it('lets the next session re-claim a conversation after the owner ends (handoff)', () => {
    const { binder, timers } = makeHarness()
    binder.registerRun('s1', '/repo', 0)
    binder.notifyTranscriptPath('s1', pathFor(UUID_X))
    timers.advance(100)
    binder.endRun('s1') // owner releases the reservation
    binder.registerRun('s2', '/repo', 0)
    binder.notifyTranscriptPath('s2', pathFor(UUID_X))
    timers.advance(100)
    expect(binder.getExactResumeTarget('s2')).toBe(pathFor(UUID_X))
  })
})

describe('#480 heuristic scan excludes conversations owned by others', () => {
  it('passes the other-owned uuids to bindOnce', () => {
    const heuristic = makeScriptedHeuristic(() => null)
    const { binder, timers } = makeHarness({ heuristicBinder: heuristic.hb })
    // s1 exact-owns X.
    binder.notifyTranscriptPath('s1', pathFor(UUID_X))
    timers.advance(100)
    // s2 starts a run; its heuristic fallback must exclude X.
    binder.registerRun('s2', '/repo', 0)
    timers.advance(20_000)
    const s2call = heuristic.calls.find((c) => c.sessionId === 's2')
    expect(s2call).toBeDefined()
    expect(s2call!.exclude && [...s2call!.exclude]).toContain(UUID_X)
  })

  it('a /clear rotation to a new uuid releases the old reservation', () => {
    const { binder, timers } = makeHarness()
    binder.notifyTranscriptPath('s1', pathFor(UUID_X))
    timers.advance(100)
    // Same session rotates to conversation Y.
    binder.notifyTranscriptPath('s1', pathFor(UUID_Y))
    timers.advance(100)
    expect(binder.getExactResumeTarget('s1')).toBe(pathFor(UUID_Y))
    // X is free again: a different live session may now claim it.
    binder.registerRun('s2', '/repo', 0)
    binder.notifyTranscriptPath('s2', pathFor(UUID_X))
    timers.advance(100)
    expect(binder.getExactResumeTarget('s2')).toBe(pathFor(UUID_X))
  })
})
