/**
 * SSH Persistent — the liveness store's reconcile actions, with the IPC mocked.
 *
 * refreshDetachedLiveness applies a probe result to the map AND prunes verified-
 * dead entries from the persisted registry (never on 'unverified'); probeGoneSessions
 * groups restored sessions by config and returns the confirmed-gone ids (fail-open
 * on an unreachable host).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DetachedRemote, DetachedRemoteLiveness } from '../../../src/shared/types'

const checkDetachedLive = vi.fn<[{ configId: string; sessionIds: string[] }], Promise<DetachedRemoteLiveness>>()
const save = vi.fn(() => Promise.resolve(true))

vi.stubGlobal('window', {
  electronAPI: {
    ssh: { checkDetachedLive },
    session: { save },
  },
})

const { useDetachedRemotesStore } = await import('../../../src/renderer/stores/detachedRemotesStore')
const { useDetachedLivenessStore, refreshDetachedLiveness, probeGoneSessions } = await import(
  '../../../src/renderer/stores/livenessStore'
)
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')

const entry = (id: string, configId = 'cfg-1'): DetachedRemote => ({
  sessionId: id,
  configId,
  host: 'pi.local',
  username: 'mong',
  remotePath: '~/work',
  mux: 'tmux',
  label: id,
  detachedAt: 1,
})

const sshConfig: any = { id: 'cfg-1', sessionType: 'ssh', sshConfig: { host: 'pi.local', port: 22, username: 'mong', remotePath: '~/work' } }

beforeEach(() => {
  checkDetachedLive.mockReset()
  save.mockClear()
  useDetachedRemotesStore.setState({ entries: [] })
  useDetachedLivenessStore.setState({ bySession: {} })
  useSessionStore.setState({ sessions: [], activeSessionId: null })
})

describe('refreshDetachedLiveness', () => {
  it('applies a verified result and PRUNES the confirmed-dead entry from the registry', async () => {
    useDetachedRemotesStore.setState({ entries: [entry('a'), entry('b')] })
    checkDetachedLive.mockResolvedValue({ outcome: 'verified', liveSessionIds: ['a'] })

    await refreshDetachedLiveness(sshConfig)

    expect(checkDetachedLive).toHaveBeenCalledWith({ configId: 'cfg-1', sessionIds: ['a', 'b'] })
    expect(useDetachedLivenessStore.getState().bySession).toEqual({ a: 'live', b: 'dead' })
    // 'b' pruned; 'a' kept.
    expect(useDetachedRemotesStore.getState().entries.map((e) => e.sessionId)).toEqual(['a'])
    expect(save).toHaveBeenCalled() // persisted the pruned registry
  })

  it('an unverified result marks all unverified and PRUNES NOTHING (fail-open)', async () => {
    useDetachedRemotesStore.setState({ entries: [entry('a'), entry('b')] })
    checkDetachedLive.mockResolvedValue({ outcome: 'unverified', liveSessionIds: [] })

    await refreshDetachedLiveness(sshConfig)

    expect(useDetachedLivenessStore.getState().bySession).toEqual({ a: 'unverified', b: 'unverified' })
    expect(useDetachedRemotesStore.getState().entries.map((e) => e.sessionId)).toEqual(['a', 'b'])
    expect(save).not.toHaveBeenCalled()
  })

  it('a thrown IPC degrades to unverified (fail-open), no prune', async () => {
    useDetachedRemotesStore.setState({ entries: [entry('a')] })
    checkDetachedLive.mockRejectedValue(new Error('host down'))

    await refreshDetachedLiveness(sshConfig)

    expect(useDetachedLivenessStore.getState().bySession).toEqual({ a: 'unverified' })
    expect(useDetachedRemotesStore.getState().entries).toHaveLength(1)
  })

  it('no-op when the config has no matching detached entries', async () => {
    await refreshDetachedLiveness(sshConfig)
    expect(checkDetachedLive).not.toHaveBeenCalled()
  })
})

// #54: the pruning seam. An entry whose config was EDITED to point elsewhere must
// not be probed through that config (it would ask the new host about the old
// session) and must never be pruned by the answer.
describe('refreshDetachedLiveness — a retargeted entry is never probed or pruned (#54)', () => {
  const recorded = (id: string): DetachedRemote => ({ ...entry(id), port: 22, runtime: { type: 'host' } })
  const edited: any = { id: 'cfg-1', sessionType: 'ssh', sshConfig: { host: 'other.box', port: 22, username: 'mong', remotePath: '~/work' } }

  it('files NO probe for the edited config and leaves the entry and its liveness untouched', async () => {
    useDetachedRemotesStore.setState({ entries: [recorded('a')] })
    checkDetachedLive.mockResolvedValue({ outcome: 'verified', liveSessionIds: [] }) // the new host has no such session

    await refreshDetachedLiveness(edited)

    expect(checkDetachedLive).not.toHaveBeenCalled()
    expect(useDetachedRemotesStore.getState().entries.map((e) => e.sessionId)).toEqual(['a'])
    expect(useDetachedLivenessStore.getState().bySession).toEqual({})
    expect(save).not.toHaveBeenCalled()
  })

  it('still probes and prunes through the UNCHANGED config (the guard is on the edit, not on the feature)', async () => {
    useDetachedRemotesStore.setState({ entries: [recorded('a')] })
    checkDetachedLive.mockResolvedValue({ outcome: 'verified', liveSessionIds: [] })

    await refreshDetachedLiveness(sshConfig)

    expect(checkDetachedLive).toHaveBeenCalledWith({ configId: 'cfg-1', sessionIds: ['a'] })
    expect(useDetachedRemotesStore.getState().entries).toEqual([])
  })

  it('a re-created config at the recorded destination probes the entry under ITS id', async () => {
    useDetachedRemotesStore.setState({ entries: [recorded('a')] })
    checkDetachedLive.mockResolvedValue({ outcome: 'verified', liveSessionIds: ['a'] })
    const recreated: any = { ...sshConfig, id: 'cfg-recreated' }

    await refreshDetachedLiveness(recreated)

    expect(checkDetachedLive).toHaveBeenCalledWith({ configId: 'cfg-recreated', sessionIds: ['a'] })
    expect(useDetachedLivenessStore.getState().bySession).toEqual({ a: 'live' })
  })

  it('a PRE-#54 entry (no port/runtime) beside its unchanged config is still probed', async () => {
    useDetachedRemotesStore.setState({ entries: [entry('a')] })
    checkDetachedLive.mockResolvedValue({ outcome: 'verified', liveSessionIds: ['a'] })
    await refreshDetachedLiveness(sshConfig)
    expect(checkDetachedLive).toHaveBeenCalledTimes(1)
  })
})

describe('probeGoneSessions (app-restart notice)', () => {
  it('returns the confirmed-gone ids, grouped by config', async () => {
    checkDetachedLive.mockImplementation(async ({ configId, sessionIds }) => {
      // cfg-1 host reports s1 alive, s2 gone; cfg-2 reports its session alive.
      if (configId === 'cfg-1') return { outcome: 'verified', liveSessionIds: sessionIds.filter((id) => id === 's1') }
      return { outcome: 'verified', liveSessionIds: sessionIds }
    })

    const gone = await probeGoneSessions([
      { id: 's1', configId: 'cfg-1' },
      { id: 's2', configId: 'cfg-1' },
      { id: 's3', configId: 'cfg-2' },
      { id: 's4' }, // no configId — cannot be probed, never gone
    ])

    expect(gone).toEqual(['s2'])
  })

  it('an unreachable host contributes NO gone ids (fail-open — no false notice)', async () => {
    checkDetachedLive.mockResolvedValue({ outcome: 'unverified', liveSessionIds: [] })
    const gone = await probeGoneSessions([{ id: 's1', configId: 'cfg-1' }])
    expect(gone).toEqual([])
  })
})
