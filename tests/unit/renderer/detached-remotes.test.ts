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
  configForDetachedEntry,
  pairDetachedEntry,
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
  it('builds an entry from a persistent SSH session (mux tmux, account descriptor, id preserved, full destination)', () => {
    const e = buildDetachedRemote(sshSession(), 4242)
    expect(e).toEqual({
      sessionId: 'sess-1',
      configId: 'cfg-1',
      host: 'pi.local',
      username: 'mong',
      remotePath: '~/work',
      // #54: the destination is recorded in full — port, and the runtime the
      // session actually ran under (a plain host session records host, not
      // "nothing", so absence can mean "pre-#54 entry").
      port: 22,
      runtime: { type: 'host' },
      mux: 'tmux',
      accountEmail: 'mong@example.com',
      label: 'Pi',
      detachedAt: 4242,
    })
  })

  it('records the container runtime a session ran under, structured or from a legacy docker post-command (#54)', () => {
    const structured = { type: 'container' as const, engine: 'podman' as const, container: 'dev' }
    expect(buildDetachedRemote(sshSession({ sshConfig: { host: 'pi.local', port: 2222, username: 'mong', remotePath: '~/work', runtime: structured } }), 0))
      .toMatchObject({ port: 2222, runtime: structured })
    const legacy = buildDetachedRemote(sshSession({ sshConfig: { host: 'pi.local', port: 22, username: 'mong', remotePath: '~/work', postCommand: 'sudo docker exec -it web bash' } }), 0)
    expect(legacy?.runtime).toMatchObject({ type: 'container', container: 'web' })
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

  it('the fallback key includes the PORT — two boxes behind one hostname are not one box (#54)', () => {
    const entries = [entry({ sessionId: 'a', configId: 'gone', port: 2222 })]
    expect(matchDetachedRemotes(entries, sshConfig({ id: 'cfg-new' }))).toEqual([]) // config is on 22
    expect(matchDetachedRemotes(entries, sshConfig({ id: 'cfg-new', sshConfig: { host: 'pi.local', port: 2222, username: 'mong', remotePath: '~/work' } })).map((e) => e.sessionId)).toEqual(['a'])
  })

  it('returns [] for a non-SSH config even if an entry shares its id (SSH-only)', () => {
    const entries = [entry({ sessionId: 'a', configId: 'cfg-1' })]
    expect(matchDetachedRemotes(entries, sshConfig({ sessionType: 'local' }))).toEqual([])
  })

  it('returns [] for an SSH config with no ssh block, even on an id match — nothing to compare against', () => {
    const entries = [entry({ sessionId: 'a', configId: 'cfg-1' })]
    expect(matchDetachedRemotes(entries, sshConfig({ sshConfig: undefined }))).toEqual([])
  })
})

// #54: editing a saved SSH config used to RETARGET its detached sessions — the
// id still matched, so liveness asked the NEW host about the OLD session (and a
// verified-empty answer pruned it), and Resume / End acted on the new host. The
// id is the strong key only while the config still points where the session
// was left; otherwise the entry is an orphan of the edit.
describe('matchDetachedRemotes — destination keying (#54)', () => {
  const recorded = () => entry({ sessionId: 'a', configId: 'cfg-1', port: 22, runtime: { type: 'host' } })
  const edited = (ssh: Partial<NonNullable<LaunchableConfig['sshConfig']>>) =>
    sshConfig({ sshConfig: { host: 'pi.local', port: 22, username: 'mong', remotePath: '~/work', ...ssh } })

  it('an id match whose HOST was edited is no match (never retargeted at the new host)', () => {
    expect(matchDetachedRemotes([recorded()], edited({ host: 'other.box' }))).toEqual([])
  })

  it('an id match whose PORT was edited is no match', () => {
    expect(matchDetachedRemotes([recorded()], edited({ port: 2222 }))).toEqual([])
  })

  it('an id match whose USER or PATH was edited is no match', () => {
    expect(matchDetachedRemotes([recorded()], edited({ username: 'root' }))).toEqual([])
    expect(matchDetachedRemotes([recorded()], edited({ remotePath: '/srv/other' }))).toEqual([])
  })

  it('an id match whose RUNTIME moved (host -> container, or another container) is no match', () => {
    expect(matchDetachedRemotes([recorded()], edited({ runtime: { type: 'container', container: 'dev' } }))).toEqual([])
    const inDev = entry({ sessionId: 'c', configId: 'cfg-1', port: 22, runtime: { type: 'container', container: 'dev' } })
    expect(matchDetachedRemotes([inDev], edited({ runtime: { type: 'container', container: 'other' } }))).toEqual([])
    expect(matchDetachedRemotes([inDev], edited({ runtime: { type: 'container', container: 'dev' } })).map((e) => e.sessionId)).toEqual(['c'])
  })

  it('the same container reached through sudo / another mode is still the same destination', () => {
    // sudo, mode and containerDir are how you get in, not where you land.
    const inDev = entry({ sessionId: 'c', configId: 'cfg-1', port: 22, runtime: { type: 'container', container: 'dev' } })
    expect(matchDetachedRemotes([inDev], edited({ runtime: { type: 'container', container: 'dev', sudo: true, mode: 'start', containerDir: '/app' } })).map((e) => e.sessionId)).toEqual(['c'])
  })

  it('a host edit that only changes case is the same box (DNS is case-insensitive)', () => {
    expect(matchDetachedRemotes([recorded()], edited({ host: 'Pi.LOCAL' })).map((e) => e.sessionId)).toEqual(['a'])
  })

  it('a PRE-#54 entry (no port, no runtime recorded) still matches its unchanged config by id', () => {
    // An old registry must not turn into a page of orphans on upgrade.
    const legacy = entry({ sessionId: 'old', configId: 'cfg-1' })
    expect(legacy.port).toBeUndefined()
    expect(legacy.runtime).toBeUndefined()
    expect(matchDetachedRemotes([legacy], sshConfig()).map((e) => e.sessionId)).toEqual(['old'])
    expect(matchDetachedRemotes([legacy], edited({ port: 2222, runtime: { type: 'container', container: 'x' } })).map((e) => e.sessionId)).toEqual(['old'])
    // ...but a host edit is still an edit.
    expect(matchDetachedRemotes([legacy], edited({ host: 'elsewhere' }))).toEqual([])
  })

  it('an orphaned entry is not matched to the edited config, but a RE-CREATED config at the old destination still finds it', () => {
    const entries = [recorded()]
    const editedAway = edited({ host: 'other.box' })
    const recreated = sshConfig({ id: 'cfg-recreated' })
    expect(matchDetachedRemotes(entries, editedAway)).toEqual([])
    expect(matchDetachedRemotes(entries, recreated).map((e) => e.sessionId)).toEqual(['a'])
  })
})

describe('configForDetachedEntry / pairDetachedEntry — the orphan row (#54)', () => {
  const recorded = () => entry({ sessionId: 'a', configId: 'cfg-1', port: 22, runtime: { type: 'host' } })
  const movedAway = () => sshConfig({ sshConfig: { host: 'other.box', port: 22, username: 'mong', remotePath: '~/work' } })

  it('an exact id whose destination moved is NOT the entry\'s config any more', () => {
    expect(configForDetachedEntry(recorded(), [movedAway()])).toBeUndefined()
  })

  it('...unless a re-created config still reaches the recorded destination — that one pairs', () => {
    expect(configForDetachedEntry(recorded(), [movedAway(), sshConfig({ id: 'cfg-recreated' })])?.id).toBe('cfg-recreated')
  })

  it('pairs: unchanged config -> paired; edited config -> retargeted (Remove only); no config -> deleted', () => {
    expect(pairDetachedEntry(recorded(), [sshConfig()])).toEqual({ kind: 'paired', config: sshConfig() })
    expect(pairDetachedEntry(recorded(), [movedAway()])).toEqual({ kind: 'retargeted', config: movedAway() })
    expect(pairDetachedEntry(recorded(), [])).toEqual({ kind: 'deleted' })
    expect(pairDetachedEntry(entry({ configId: 'gone' }), [movedAway()])).toEqual({ kind: 'deleted' })
  })

  it('a config switched from SSH to local is retargeted too (it exists, and points nowhere the session is)', () => {
    expect(pairDetachedEntry(recorded(), [sshConfig({ sessionType: 'local' })]).kind).toBe('retargeted')
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

describe('configForDetachedEntry', () => {
  it('finds the config by its id', () => {
    const configs = [sshConfig({ id: 'other' }), sshConfig({ id: 'cfg-1' })]
    expect(configForDetachedEntry(entry(), configs)?.id).toBe('cfg-1')
  })

  it('prefers the EXACT configId over another config that merely shares the host', () => {
    // Both match under matchDetachedRemotes' host+user+path fallback. Resuming
    // into the wrong template (different account, model, post-command) is worse
    // than treating the entry as config-less, so the id must win outright.
    const sameHostDifferentConfig = sshConfig({ id: 'cfg-2' })
    const configs = [sameHostDifferentConfig, sshConfig({ id: 'cfg-1' })]
    expect(configForDetachedEntry(entry({ configId: 'cfg-1' }), configs)?.id).toBe('cfg-1')
  })

  it('falls back to host+user+path for a RE-CREATED config (new id, same remote)', () => {
    const configs = [sshConfig({ id: 'cfg-recreated' })]
    expect(configForDetachedEntry(entry({ configId: 'cfg-deleted' }), configs)?.id).toBe('cfg-recreated')
  })

  it('returns undefined when the saved config was DELETED — the resume surface renders it anyway', () => {
    expect(configForDetachedEntry(entry(), [])).toBeUndefined()
    expect(
      configForDetachedEntry(entry({ configId: 'gone' }), [sshConfig({ id: 'x', sshConfig: { host: 'elsewhere', port: 22, username: 'z', remotePath: '/z' } })]),
    ).toBeUndefined()
  })

  it('never pairs an entry with a non-SSH config', () => {
    expect(configForDetachedEntry(entry({ configId: undefined }), [sshConfig({ id: 'local-1', sessionType: 'local' })])).toBeUndefined()
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
