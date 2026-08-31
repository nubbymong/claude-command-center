/**
 * SSH Persistent — "Resume a Running Session": the pure registry helpers.
 *
 * These back the whole feature — building an entry from a left-running session,
 * matching the registry against a config, and dropping anything already live (the
 * guard that keeps app-restart restore from ever offering a session that just
 * came back). They feed the RESUME surface, never the launch path (a config launch
 * always starts new). No store, no React, no window.
 */
import { describe, it, expect } from 'vitest'
import {
  buildDetachedRemote,
  matchDetachedRemotes,
  filterLiveEntries,
  resumableRemotesForConfig,
  describeDetachedAge,
  type DetachableSession,
  type LaunchableConfig,
} from '../../../src/renderer/utils/detachedRemotes'
import type { DetachedRemote } from '../../../src/shared/types'

const sshSession = (over: Partial<DetachableSession> = {}): DetachableSession => ({
  id: 'sess-1',
  configId: 'cfg-1',
  sessionType: 'ssh',
  sshConfig: { host: 'pi.local', port: 22, username: 'mong', remotePath: '~/work' },
  sshRemoteAccount: 'mong@example.com',
  label: 'Pi',
  ...over,
})

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

const sshConfig = (over: Partial<LaunchableConfig> = {}): LaunchableConfig => ({
  id: 'cfg-1',
  sessionType: 'ssh',
  sshConfig: { host: 'pi.local', port: 22, username: 'mong', remotePath: '~/work' },
  ...over,
})

describe('buildDetachedRemote', () => {
  it('builds an entry from a persistent SSH session (mux tmux, account descriptor, id preserved)', () => {
    const e = buildDetachedRemote(sshSession(), 4242)
    expect(e).toEqual({
      sessionId: 'sess-1',
      configId: 'cfg-1',
      host: 'pi.local',
      username: 'mong',
      remotePath: '~/work',
      mux: 'tmux',
      accountEmail: 'mong@example.com',
      label: 'Pi',
      detachedAt: 4242,
    })
  })

  it('prefers the customName over the config label', () => {
    expect(buildDetachedRemote(sshSession({ customName: '  Deploy box ' }), 0)?.label).toBe('Deploy box')
  })

  it('returns null for a non-SSH session (nothing to reattach)', () => {
    expect(buildDetachedRemote(sshSession({ sessionType: 'local' }), 0)).toBeNull()
  })

  it('returns null for an SSH session with no sshConfig, and for null', () => {
    expect(buildDetachedRemote(sshSession({ sshConfig: undefined }), 0)).toBeNull()
    expect(buildDetachedRemote(null, 0)).toBeNull()
    expect(buildDetachedRemote(undefined, 0)).toBeNull()
  })
})

describe('matchDetachedRemotes', () => {
  it('matches by configId first', () => {
    const entries = [entry({ sessionId: 'a', configId: 'cfg-1' }), entry({ sessionId: 'b', configId: 'other' })]
    const m = matchDetachedRemotes(entries, sshConfig())
    expect(m.map((e) => e.sessionId)).toEqual(['a'])
  })

  it('falls back to host+username+remotePath when no configId matches', () => {
    // Entry was recorded under a since-deleted config id, but points at the same remote.
    const entries = [entry({ sessionId: 'a', configId: 'gone', host: 'pi.local', username: 'mong', remotePath: '~/work' })]
    const m = matchDetachedRemotes(entries, sshConfig({ id: 'cfg-new' }))
    expect(m.map((e) => e.sessionId)).toEqual(['a'])
  })

  it('does not fall back when host/user/remotePath differ', () => {
    const entries = [entry({ sessionId: 'a', configId: 'gone', host: 'other.host' })]
    expect(matchDetachedRemotes(entries, sshConfig({ id: 'cfg-new' }))).toEqual([])
  })

  it('returns [] for a non-SSH config even if an entry shares its id (SSH-only)', () => {
    const entries = [entry({ sessionId: 'a', configId: 'cfg-1' })]
    expect(matchDetachedRemotes(entries, sshConfig({ sessionType: 'local' }))).toEqual([])
  })
})

describe('filterLiveEntries', () => {
  it('drops entries whose sessionId is currently live (array or Set)', () => {
    const entries = [entry({ sessionId: 'a' }), entry({ sessionId: 'b' })]
    expect(filterLiveEntries(entries, ['a']).map((e) => e.sessionId)).toEqual(['b'])
    expect(filterLiveEntries(entries, new Set(['b'])).map((e) => e.sessionId)).toEqual(['a'])
  })

  it('keeps everything when nothing is live', () => {
    const entries = [entry({ sessionId: 'a' }), entry({ sessionId: 'b' })]
    expect(filterLiveEntries(entries, []).length).toBe(2)
  })
})

describe('resumableRemotesForConfig (what the resume surface may offer)', () => {
  it('offers a matched, not-live remote', () => {
    const entries = [entry({ sessionId: 'a', configId: 'cfg-1' })]
    expect(resumableRemotesForConfig(entries, sshConfig(), []).map((e) => e.sessionId)).toEqual(['a'])
  })

  it('offers NOTHING when the matched remote is already live — the app-restart guard', () => {
    // A restored session keeps its id; if an entry ever shares it, the live-filter
    // must exclude it so restore never triggers the resume prompt.
    const entries = [entry({ sessionId: 'restored', configId: 'cfg-1' })]
    expect(resumableRemotesForConfig(entries, sshConfig(), ['restored'])).toEqual([])
  })

  it('offers nothing for a config with no matching remote', () => {
    const entries = [entry({ sessionId: 'a', configId: 'someone-else' })]
    expect(resumableRemotesForConfig(entries, sshConfig({ id: 'cfg-z', sshConfig: { host: 'z', port: 22, username: 'z', remotePath: '/z' } }), [])).toEqual([])
  })
})

describe('describeDetachedAge', () => {
  it('reads just now / minutes / hours / days', () => {
    const now = 1_000_000_000
    expect(describeDetachedAge(now, now)).toBe('just now')
    expect(describeDetachedAge(now - 30_000, now)).toBe('just now')
    expect(describeDetachedAge(now - 5 * 60_000, now)).toBe('5m ago')
    expect(describeDetachedAge(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(describeDetachedAge(now - 2 * 86_400_000, now)).toBe('2d ago')
  })

  it('never goes negative on a clock skew', () => {
    expect(describeDetachedAge(1000, 0)).toBe('just now')
  })
})
