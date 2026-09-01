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
import { useDetachedRemotesStore, DETACHED_REMOTES_MAX } from '../../../src/renderer/stores/detachedRemotesStore'
import { distinctHosts } from '../../../src/renderer/utils/detachedRemotesLiveness'
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

// ── What comes off DISK is not a DetachedRemote[] just because it parsed ─────
//
// session-state.json round-trips this array UNTOUCHED by design (the main-side
// loader migrates only `sessions`), so `hydrate` is a trust boundary and the old
// `Array.isArray` check was the only thing at it. A `[null]` or a `{}` went
// straight into the store and the first consumer threw: `distinctHosts` reads
// `e.host` on every tick of the 90s reachability timer, so one malformed row was
// an unhandled rejection a minute and a half, for ever. An oversized array was
// separately an amplifier — one ping per distinct host, per tick.
//
// Mutation to prove these can fail: put `Array.isArray(entries) ? entries : []`
// back in `hydrate` (detachedRemotesStore.ts).
describe('hydrate is a trust boundary', () => {
  it('drops malformed entries and keeps the valid ones', () => {
    const good = entry({ sessionId: 'ok' })
    useDetachedRemotesStore.getState().hydrate([null, {}, good] as unknown as DetachedRemote[])
    expect(useDetachedRemotesStore.getState().entries).toEqual([good])
  })

  it('rejects every shape a hand-edited or truncated file can produce', () => {
    const bad: unknown[] = [
      null, undefined, 42, 'a string', [], true,
      {},
      entry({ sessionId: '' }),                                  // empty id
      { ...entry(), sessionId: undefined },                       // missing id
      { ...entry(), host: '' },                                   // empty host — the distinctHosts input
      { ...entry(), host: 42 },                                   // wrong type
      { ...entry(), username: '' },
      { ...entry(), remotePath: null },
      { ...entry(), mux: 'screen' },                              // outside the union
      { ...entry(), label: 12 },
      { ...entry(), detachedAt: 'yesterday' },
      { ...entry(), detachedAt: Number.NaN },
      { ...entry(), configId: 7 },                                // optional, but typed
      { ...entry(), accountEmail: {} },
    ]
    useDetachedRemotesStore.getState().hydrate(bad as DetachedRemote[])
    expect(useDetachedRemotesStore.getState().entries).toEqual([])
  })

  it('keeps the optional fields optional — absent is not malformed', () => {
    const minimal = { ...entry() } as Record<string, unknown>
    delete minimal.configId
    delete minimal.accountEmail
    useDetachedRemotesStore.getState().hydrate([minimal] as unknown as DetachedRemote[])
    expect(useDetachedRemotesStore.getState().entries).toHaveLength(1)
  })

  it('caps the registry, so an oversized file cannot amplify the ping fan-out', () => {
    const many = Array.from({ length: DETACHED_REMOTES_MAX + 500 }, (_, i) =>
      entry({ sessionId: `s${i}`, host: `h${i}.local` }))
    useDetachedRemotesStore.getState().hydrate(many)
    expect(useDetachedRemotesStore.getState().entries).toHaveLength(DETACHED_REMOTES_MAX)
    expect(distinctHosts(useDetachedRemotesStore.getState().entries)).toHaveLength(DETACHED_REMOTES_MAX)
  })

  it('distinctHosts never throws on a hydrated registry, whatever was on disk', () => {
    const junk = [null, {}, { host: null }, 'x', entry({ sessionId: 'ok', host: 'pi.local' })]
    useDetachedRemotesStore.getState().hydrate(junk as unknown as DetachedRemote[])
    expect(() => distinctHosts(useDetachedRemotesStore.getState().entries)).not.toThrow()
    expect(distinctHosts(useDetachedRemotesStore.getState().entries)).toEqual(['pi.local'])
  })
})
