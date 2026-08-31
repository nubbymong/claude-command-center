// @vitest-environment jsdom
/**
 * Allow Multi Spawn — the post-install startup page (phase 5).
 *
 * Three things are pinned here, and the third is the one that bites:
 *
 *  1. WHEN IT SHOWS. Once per upgrade, never on a fresh install, never twice on
 *     one build, and silently stamped away when there is nothing to list. The
 *     marker is a version stamp, mirroring What's New — see
 *     onboarding/multi-spawn-intro-gate.ts. (The ORDERING against the release
 *     notes lives with the chain that decides it, in boot-gates.test.ts.)
 *  2. WHERE EACH TOGGLE STARTS. The EFFECTIVE value, not the stored one: a
 *     config the migration is about to enable must not render OFF for the frame
 *     before it is written. This is the helper the whole page is a rendering of,
 *     so its truth table is exhaustive.
 *  3. WHAT CONTINUE WRITES. Un-ticking an auto-enabled row has to store an
 *     explicit `false`. It holds `undefined` on disk at that moment, so the
 *     obvious `resolveAllowMultiSpawnOnSave(false, stored)` resolves back to
 *     `undefined` — "never chosen" — and the next start's migration switches it
 *     straight on again. The decline must survive future migrations, which is
 *     the entire point of phase 4.1.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
// The build define the real gate reads. Without it `runningVersion()` answers
// '' and the marker is never stamped — which is the correct fail-safe, but it
// would make every assertion below vacuous.
;(globalThis as any).__APP_VERSION__ = '2.1.0'

const CONFIG: any = { configs: [], groups: [], updateConfig: vi.fn() }
const SESSIONS: any = { sessions: [] }
const DETACHED: any = { entries: [] }
const LIVENESS: any = { bySession: {} }
const HOSTS: any = { byHost: {} }
const APP_META: any = {
  meta: {} as Record<string, unknown>,
  update: vi.fn((u: Record<string, unknown>) => { APP_META.meta = { ...APP_META.meta, ...u } }),
}

const store = (state: any) => {
  const hook: any = (sel: any) => sel(state)
  hook.getState = () => state
  return hook
}

vi.mock('../../../src/renderer/stores/configStore', () => ({ useConfigStore: store(CONFIG) }))
vi.mock('../../../src/renderer/stores/sessionStore', () => ({ useSessionStore: store(SESSIONS) }))
vi.mock('../../../src/renderer/stores/detachedRemotesStore', () => ({ useDetachedRemotesStore: store(DETACHED) }))
vi.mock('../../../src/renderer/stores/livenessStore', () => ({ useDetachedLivenessStore: store(LIVENESS) }))
vi.mock('../../../src/renderer/stores/hostReachability', () => ({ useHostReachabilityStore: store(HOSTS) }))
vi.mock('../../../src/renderer/stores/appMetaStore', () => ({ useAppMetaStore: store(APP_META) }))
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))

const { MultiSpawnStartupPage, groupConfigsForStartup } =
  await import('../../../src/renderer/components/MultiSpawnStartupPage')
const { decideMultiSpawnIntro, markMultiSpawnIntroSeen } =
  await import('../../../src/renderer/onboarding/multi-spawn-intro-gate')
const { multiSpawnStartupRowState, resolveStartupRowSave, resumingSessionCount } =
  await import('../../../src/renderer/utils/multiSpawn')

const cfg = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  label: id,
  workingDirectory: '/x',
  color: '',
  sessionType: 'local',
  provider: 'claude',
  ...over,
}) as any

const sshCfg = (id: string, over: Record<string, unknown> = {}) =>
  cfg(id, {
    sessionType: 'ssh',
    sshConfig: { host: 'pi.local', port: 22, username: 'mong', remotePath: '~/w' },
    ...over,
  })

const sess = (id: string, configId?: string, kind?: string) => ({ id, configId, kind }) as any

const remote = (sessionId: string, configId: string, over: Record<string, unknown> = {}) => ({
  sessionId,
  configId,
  host: 'pi.local',
  username: 'mong',
  remotePath: '~/w',
  mux: 'tmux' as const,
  label: configId,
  detachedAt: 1,
  ...over,
}) as any

// ── 1. the gate ─────────────────────────────────────────────────────────────

describe('decideMultiSpawnIntro — once per upgrade', () => {
  const base = { currentVersion: '2.1.0', configCount: 3 }

  it('shows on an upgrade from an earlier build', () => {
    const d = decideMultiSpawnIntro({ ...base, lastSeenVersion: '2.0.9', lastRunVersion: '2.0.9' })
    expect(d).toEqual({ show: true, markSeen: false, reason: 'due' })
  })

  it('does NOT show on the second start of the same build', () => {
    const d = decideMultiSpawnIntro({
      ...base, lastSeenVersion: '2.1.0', lastRunVersion: '2.1.0', multiSpawnIntroVersion: '2.1.0',
    })
    expect(d).toEqual({ show: false, markSeen: false, reason: 'already-seen' })
  })

  it('treats a differently-formatted stamp as the same release', () => {
    // `v2.1.0` and `2.1.0` are one build; a formatting difference must not
    // re-fire a once-per-upgrade page on every launch.
    const d = decideMultiSpawnIntro({
      ...base, lastSeenVersion: '2.0.9', lastRunVersion: '2.0.9', multiSpawnIntroVersion: 'v2.1.0',
    })
    expect(d.show).toBe(false)
    expect(d.reason).toBe('already-seen')
  })

  it('NEVER shows on a fresh install — and stamps, so it does not ambush them later on this build', () => {
    // No stored seen-version is what "first install" means to the What's New
    // gate, and the two must agree about whose launch is a first one.
    const d = decideMultiSpawnIntro({ ...base, configCount: 0 })
    expect(d).toEqual({ show: false, markSeen: true, reason: 'fresh-install' })
    // …and still a fresh install even if they somehow already have configs.
    expect(decideMultiSpawnIntro({ ...base, configCount: 5 }).reason).toBe('fresh-install')
  })

  it('no saved configs: stamps SILENTLY rather than showing an empty list', () => {
    const d = decideMultiSpawnIntro({ ...base, configCount: 0, lastSeenVersion: '2.0.9', lastRunVersion: '2.0.9' })
    expect(d).toEqual({ show: false, markSeen: true, reason: 'no-configs' })
  })

  it('shows again after a LATER upgrade — the marker is per-build, not once-ever', () => {
    const d = decideMultiSpawnIntro({
      currentVersion: '2.2.0', configCount: 2, lastSeenVersion: '2.1.0', lastRunVersion: '2.1.0',
      multiSpawnIntroVersion: '2.1.0',
    })
    expect(d.show).toBe(true)
  })

  it('a build with no version define shows nothing and stamps nothing', () => {
    const d = decideMultiSpawnIntro({ currentVersion: '', configCount: 3, lastSeenVersion: '2.0.9' })
    expect(d).toEqual({ show: false, markSeen: false, reason: 'no-version' })
  })

  it('the stamp records the version RUNNING, never the changelog head (#369)', () => {
    APP_META.meta = {}
    markMultiSpawnIntroSeen()
    expect(APP_META.meta.multiSpawnIntroVersion).toBe('2.1.0')
    // And it is its OWN field: stamping this must not claim the release notes
    // were read, nor be satisfied by them having been.
    expect(APP_META.meta.lastSeenVersion).toBeUndefined()
  })
})

// ── 2. the effective initial state ──────────────────────────────────────────

describe('multiSpawnStartupRowState — where each toggle starts', () => {
  // Exhaustive by construction: every arm of the helper appears at least twice
  // with a different expectation, so flipping any one of them fails a case.
  const cases: Array<{
    name: string
    stored: unknown
    copies: number
    auto: string[]
    expect: { enabled: boolean; auto: boolean }
  }> = [
    { name: 'stored true, user set it earlier', stored: true, copies: 0, auto: [], expect: { enabled: true, auto: false } },
    { name: 'stored true with copies but not migrated this start', stored: true, copies: 3, auto: [], expect: { enabled: true, auto: false } },
    { name: 'stored true because THIS start migrated it', stored: true, copies: 2, auto: ['a'], expect: { enabled: true, auto: true } },
    { name: 'migrated this start but a copy has since exited — on, no chip', stored: true, copies: 1, auto: ['a'], expect: { enabled: true, auto: false } },
    { name: 'never chosen, two copies — the migration is about to enable it', stored: undefined, copies: 2, auto: [], expect: { enabled: true, auto: true } },
    { name: 'never chosen, one copy', stored: undefined, copies: 1, auto: [], expect: { enabled: false, auto: false } },
    { name: 'never chosen, no copies', stored: undefined, copies: 0, auto: [], expect: { enabled: false, auto: false } },
    { name: 'EXPLICITLY DECLINED, three copies — off, and no chip', stored: false, copies: 3, auto: [], expect: { enabled: false, auto: false } },
    { name: 'explicitly declined, no copies', stored: false, copies: 0, auto: [], expect: { enabled: false, auto: false } },
    { name: 'hand-edited garbage fails closed', stored: 'yes', copies: 3, auto: [], expect: { enabled: false, auto: false } },
  ]

  for (const c of cases) {
    it(c.name, () => {
      const config = cfg('a', { allowMultiSpawn: c.stored })
      const sessions = Array.from({ length: c.copies }, (_, i) => sess(`s${i}`, 'a'))
      const state = multiSpawnStartupRowState(config, sessions, [], c.auto)
      expect(state.count).toBe(c.copies)
      expect(state.enabled).toBe(c.expect.enabled)
      expect(state.auto).toBe(c.expect.auto)
    })
  }

  it('counts a resumable remote as a copy, like the migration does', () => {
    const state = multiSpawnStartupRowState(sshCfg('a'), [sess('s1', 'a')], [remote('det-1', 'a')])
    expect(state.count).toBe(2)
    expect(state).toMatchObject({ enabled: true, auto: true })
  })
})

describe('resolveStartupRowSave — what Continue writes', () => {
  const rowFor = (stored: unknown, copies: number, auto: string[] = []) =>
    multiSpawnStartupRowState(
      cfg('a', { allowMultiSpawn: stored }),
      Array.from({ length: copies }, (_, i) => sess(`s${i}`, 'a')),
      [], auto,
    )

  it('un-ticking an AUTO-ENABLED row stores an explicit false, not undefined', () => {
    // The bug this exists to prevent: `undefined` means "never chosen", so the
    // next start's migration sees two copies and turns it back on. Forever.
    const row = rowFor(undefined, 2)
    expect(row.enabled).toBe(true)
    expect(resolveStartupRowSave(false, row, undefined)).toBe(false)
  })

  it('un-ticking a row the migration ALREADY wrote also stores false', () => {
    expect(resolveStartupRowSave(false, rowFor(true, 2, ['a']), true)).toBe(false)
  })

  it('leaving an untouched never-chosen row alone keeps it undefined', () => {
    expect(resolveStartupRowSave(false, rowFor(undefined, 1), undefined)).toBeUndefined()
  })

  it('ticking anything stores true', () => {
    expect(resolveStartupRowSave(true, rowFor(undefined, 0), undefined)).toBe(true)
    expect(resolveStartupRowSave(true, rowFor(false, 0), false)).toBe(true)
  })

  it('a standing decline left alone stays a decline', () => {
    expect(resolveStartupRowSave(false, rowFor(false, 3), false)).toBe(false)
  })
})

describe('resumingSessionCount', () => {
  it('adds restored sessions to registry entries', () => {
    expect(resumingSessionCount([sess('s1', 'a'), sess('s2', 'b')], [remote('det-1', 'c')])).toBe(3)
  })

  it('never double-counts a remote whose session came back live', () => {
    expect(resumingSessionCount([sess('det-1', 'a')], [remote('det-1', 'a')])).toBe(1)
  })

  it('skips the config-less Ask Conductor session', () => {
    expect(resumingSessionCount([sess('ask', undefined, 'ask')], [])).toBe(0)
  })

  it('is zero when nothing is coming back', () => {
    expect(resumingSessionCount([], [])).toBe(0)
  })
})

describe('groupConfigsForStartup — the sidebar\'s grouping', () => {
  it('groups in the sidebar\'s order with Ungrouped last', () => {
    const groups = [{ id: 'g1', name: 'Servers' }, { id: 'g2', name: 'Raspberry Pis' }] as any
    const configs = [cfg('loose'), cfg('a', { groupId: 'g1' }), cfg('b', { groupId: 'g2' })]
    expect(groupConfigsForStartup(configs, groups).map((g) => [g.name, g.configs.map((c) => c.id)]))
      .toEqual([['Servers', ['a']], ['Raspberry Pis', ['b']], ['Ungrouped', ['loose']]])
  })

  it('a stale groupId counts as loose, exactly as the sidebar treats it', () => {
    const out = groupConfigsForStartup([cfg('a', { groupId: 'gone' })], [])
    expect(out).toEqual([{ id: null, name: 'Ungrouped', configs: [expect.objectContaining({ id: 'a' })] }])
  })

  it('drops an empty group rather than showing a heading over nothing', () => {
    expect(groupConfigsForStartup([], [{ id: 'g1', name: 'Servers' } as any])).toEqual([])
  })
})

// ── 3. the page itself ──────────────────────────────────────────────────────

describe('MultiSpawnStartupPage — the real page', () => {
  let container: HTMLDivElement
  let root: Root
  let onDone: ReturnType<typeof vi.fn>

  beforeEach(() => {
    CONFIG.configs = []
    CONFIG.groups = []
    CONFIG.updateConfig = vi.fn()
    SESSIONS.sessions = []
    DETACHED.entries = []
    LIVENESS.bySession = {}
    HOSTS.byHost = {}
    APP_META.meta = {}
    APP_META.update = vi.fn((u: Record<string, unknown>) => { APP_META.meta = { ...APP_META.meta, ...u } })
    onDone = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  const render = (autoEnabledIds: string[] = []) =>
    act(() => root.render(React.createElement(MultiSpawnStartupPage, { autoEnabledIds, onDone })))

  const q = (sel: string) => container.querySelector(sel) as HTMLElement | null
  const rowEl = (id: string) => q(`[data-testid="multi-spawn-startup-row"][data-config-id="${id}"]`)!
  const toggleEl = (id: string) => rowEl(id).querySelector('[role="switch"]') as HTMLElement
  const chipEl = (id: string) => q(`[data-testid="multi-spawn-startup-autochip"][data-config-id="${id}"]`)
  const click = (el: HTMLElement) => act(() => { el.click() })

  it('lists every saved config, grouped, with the hero and the safety note', () => {
    CONFIG.groups = [{ id: 'g1', name: 'Servers' }]
    CONFIG.configs = [cfg('web', { groupId: 'g1' }), cfg('local')]
    render()
    expect(q('h1')!.textContent).toBe('Enable Multi Spawn')
    expect(container.querySelectorAll('[data-testid="multi-spawn-startup-row"]').length).toBe(2)
    expect(Array.from(container.querySelectorAll('[data-testid="multi-spawn-startup-group"]'))
      .map((g) => g.getAttribute('data-group-name'))).toEqual(['Servers', 'Ungrouped'])
    expect(q('[data-testid="multi-spawn-startup-note"]')!.textContent).toContain('Skipping is safe.')
  })

  it('no resuming sessions: NO strip, and no counts derived from them', () => {
    CONFIG.configs = [cfg('a'), cfg('b', { allowMultiSpawn: true })]
    render()
    expect(q('[data-testid="multi-spawn-startup-resume-note"]')).toBeNull()
    expect(container.querySelectorAll('[data-testid="multi-spawn-startup-autochip"]').length).toBe(0)
  })

  it('sessions resuming: the strip says how many, and it is the number the counts came from', () => {
    CONFIG.configs = [cfg('a')]
    SESSIONS.sessions = [sess('s1', 'a'), sess('s2', 'a')]
    DETACHED.entries = []
    render()
    const strip = q('[data-testid="multi-spawn-startup-resume-note"]')!
    expect(strip.textContent).toContain('2 sessions about to resume')
    // …and the row's own chip agrees with it.
    expect(chipEl('a')!.textContent).toContain('2 copies found')
  })

  it('singular strip copy for a single resuming session', () => {
    CONFIG.configs = [cfg('a')]
    SESSIONS.sessions = [sess('s1', 'a')]
    render()
    expect(q('[data-testid="multi-spawn-startup-resume-note"]')!.textContent).toContain('1 session about to resume')
  })

  it('initial toggle states: stored-true on, migration-enable on + chip, undefined off, declined off with NO chip', () => {
    CONFIG.configs = [
      cfg('stored-on', { allowMultiSpawn: true }),
      cfg('migrating'),
      cfg('untouched'),
      cfg('declined', { allowMultiSpawn: false }),
    ]
    SESSIONS.sessions = [
      sess('m1', 'migrating'), sess('m2', 'migrating'),
      sess('d1', 'declined'), sess('d2', 'declined'), sess('d3', 'declined'),
    ]
    render()
    expect(toggleEl('stored-on').getAttribute('aria-checked')).toBe('true')
    expect(toggleEl('migrating').getAttribute('aria-checked')).toBe('true')
    expect(toggleEl('untouched').getAttribute('aria-checked')).toBe('false')
    expect(toggleEl('declined').getAttribute('aria-checked')).toBe('false')
    expect(chipEl('migrating')!.textContent).toContain('auto · 2 copies found')
    // The decline is the load-bearing one: three copies are live and it still
    // renders OFF with no chip, because the migration promised not to touch it.
    expect(chipEl('declined')).toBeNull()
    expect(chipEl('stored-on')).toBeNull()
  })

  it('a row the migration enabled BEFORE the page mounted still gets its chip', () => {
    // By the time the page opens, App.tsx has already written `true`, so the
    // stored value no longer says who set it — autoEnabledIds does.
    CONFIG.configs = [cfg('a', { allowMultiSpawn: true })]
    SESSIONS.sessions = [sess('s1', 'a'), sess('s2', 'a')]
    render(['a'])
    expect(chipEl('a')!.textContent).toContain('auto · 2 copies found')
  })

  it('Continue persists the tri-state correctly across all four row kinds', () => {
    CONFIG.configs = [
      cfg('turn-off-auto'),                          // undefined + 2 copies => auto-on
      cfg('untouched'),                              // undefined, single copy
      cfg('turn-on'),                                // undefined, user ticks it
      cfg('stored-on', { allowMultiSpawn: true }),   // already true, left alone
    ]
    SESSIONS.sessions = [sess('a1', 'turn-off-auto'), sess('a2', 'turn-off-auto'), sess('u1', 'untouched')]
    render()
    click(toggleEl('turn-off-auto'))
    click(toggleEl('turn-on'))
    click(q('[data-testid="multi-spawn-startup-continue"]')!)

    const written = new Map<string, unknown>(
      CONFIG.updateConfig.mock.calls.map((c: any[]) => [c[0], c[1].allowMultiSpawn]),
    )
    // The decline must be EXPLICIT or the next start's migration undoes it.
    expect(written.get('turn-off-auto')).toBe(false)
    expect(written.get('turn-on')).toBe(true)
    // Untouched rows are not rewritten at all: still `undefined` on disk, still
    // clean, still eligible for grandfathering later.
    expect(written.has('untouched')).toBe(false)
    expect(written.has('stored-on')).toBe(false)
    expect(APP_META.meta.multiSpawnIntroVersion).toBe('2.1.0')
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('Skip persists NOTHING but the seen marker', () => {
    CONFIG.configs = [cfg('auto'), cfg('plain')]
    SESSIONS.sessions = [sess('s1', 'auto'), sess('s2', 'auto')]
    render()
    click(q('[data-testid="multi-spawn-startup-skip"]')!)
    expect(CONFIG.updateConfig).not.toHaveBeenCalled()
    expect(APP_META.meta.multiSpawnIntroVersion).toBe('2.1.0')
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('a flip survives a re-render — user decisions outrank the derived state', () => {
    CONFIG.configs = [cfg('a')]
    SESSIONS.sessions = [sess('s1', 'a'), sess('s2', 'a')]
    render()
    expect(toggleEl('a').getAttribute('aria-checked')).toBe('true')
    click(toggleEl('a'))
    expect(toggleEl('a').getAttribute('aria-checked')).toBe('false')
    // A session finishing its restore re-derives every row; the decline stays.
    SESSIONS.sessions = [...SESSIONS.sessions, sess('s3', 'a')]
    render()
    expect(toggleEl('a').getAttribute('aria-checked')).toBe('false')
  })

  it('reuses the sidebar\'s badges so a config is recognisable by eye', () => {
    CONFIG.configs = [sshCfg('pi', { allowMultiSpawn: true })]
    DETACHED.entries = [remote('det-1', 'pi')]
    LIVENESS.bySession = { 'det-1': 'live' }
    render()
    const row = rowEl('pi')
    expect(row.querySelector('[data-testid="type-badge-claude"]')).toBeTruthy()
    expect(row.querySelector('[data-testid="ssh-persistent-badge"]')).toBeTruthy()
    expect(row.querySelector('[data-testid="ssh-reattach-badge"]')!.textContent).toContain('1')
  })
})
