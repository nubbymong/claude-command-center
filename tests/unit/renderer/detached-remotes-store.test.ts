/**
 * SSH Persistent — the detached-remote registry store + its persistence shape.
 *
 * The store is a plain zustand registry (no window / IPC). The persistence
 * contract is that an entry survives the SAME JSON save/load the main process
 * does (session-state.json is written with JSON.stringify and read with
 * JSON.parse, migrating only `sessions`) — so a top-level `detachedRemotes`
 * array round-trips untouched.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useDetachedRemotesStore } from '../../../src/renderer/stores/detachedRemotesStore'
import type { DetachedRemote, SessionState } from '../../../src/shared/types'

const entry = (over: Partial<DetachedRemote> = {}): DetachedRemote => ({
  sessionId: 'sess-1',
  configId: 'cfg-1',
  host: 'pi.local',
  username: 'mong',
  remotePath: '~/work',
  mux: 'tmux',
  label: 'Pi',
  detachedAt: 1000,
  ...over,
})

beforeEach(() => {
  useDetachedRemotesStore.setState({ entries: [] })
})

describe('registry add / remove / hydrate', () => {
  it('adds entries', () => {
    useDetachedRemotesStore.getState().add(entry({ sessionId: 'a' }))
    useDetachedRemotesStore.getState().add(entry({ sessionId: 'b' }))
    expect(useDetachedRemotesStore.getState().entries.map((e) => e.sessionId)).toEqual(['a', 'b'])
  })

  it('dedupes by sessionId — a re-detach supersedes the stale record', () => {
    useDetachedRemotesStore.getState().add(entry({ sessionId: 'a', detachedAt: 1 }))
    useDetachedRemotesStore.getState().add(entry({ sessionId: 'a', detachedAt: 2 }))
    const { entries } = useDetachedRemotesStore.getState()
    expect(entries).toHaveLength(1)
    expect(entries[0].detachedAt).toBe(2)
  })

  it('removes by sessionId', () => {
    useDetachedRemotesStore.getState().add(entry({ sessionId: 'a' }))
    useDetachedRemotesStore.getState().add(entry({ sessionId: 'b' }))
    useDetachedRemotesStore.getState().remove('a')
    expect(useDetachedRemotesStore.getState().entries.map((e) => e.sessionId)).toEqual(['b'])
  })

  it('remove of an unregistered id preserves array identity (no churn)', () => {
    useDetachedRemotesStore.getState().add(entry({ sessionId: 'a' }))
    const before = useDetachedRemotesStore.getState().entries
    useDetachedRemotesStore.getState().remove('nope')
    expect(useDetachedRemotesStore.getState().entries).toBe(before)
  })

  it('hydrate replaces the registry, and coerces a non-array to []', () => {
    useDetachedRemotesStore.getState().add(entry({ sessionId: 'a' }))
    useDetachedRemotesStore.getState().hydrate([entry({ sessionId: 'x' }), entry({ sessionId: 'y' })])
    expect(useDetachedRemotesStore.getState().entries.map((e) => e.sessionId)).toEqual(['x', 'y'])
    useDetachedRemotesStore.getState().hydrate(undefined)
    expect(useDetachedRemotesStore.getState().entries).toEqual([])
  })
})

describe('persist round-trip (survives the main-side JSON save/load)', () => {
  it('a detachedRemotes array survives JSON.parse(JSON.stringify(...)) and re-hydrates', () => {
    const original = [entry({ sessionId: 'a' }), entry({ sessionId: 'b', accountEmail: 'x@y.z' })]
    const state: SessionState = { sessions: [], activeSessionId: null, savedAt: 123, detachedRemotes: original }

    // Exactly what saveSessionState → loadSessionState do to the top-level object.
    const roundTripped = JSON.parse(JSON.stringify(state)) as SessionState

    expect(roundTripped.detachedRemotes).toEqual(original)
    useDetachedRemotesStore.getState().hydrate(roundTripped.detachedRemotes)
    expect(useDetachedRemotesStore.getState().entries).toEqual(original)
  })

  it('a pre-feature file with no detachedRemotes hydrates to an empty registry', () => {
    const legacy = JSON.parse(JSON.stringify({ sessions: [], activeSessionId: null, savedAt: 1 })) as SessionState
    useDetachedRemotesStore.getState().hydrate(legacy.detachedRemotes)
    expect(useDetachedRemotesStore.getState().entries).toEqual([])
  })
})
