// @vitest-environment jsdom
// restoreSavedSessions (lifted out of App.tsx by #615) had no test of its own:
// the final adversarial pass on 2.1.1 ran four mutants against it -- the
// unsettled ref never cleared, markRestored dropped, the persistent-SSH probe
// filter flipped, the reachability ping dropped -- and all four stayed green
// across the whole renderer suite. Each case below is one of those mutants,
// plus the neighbouring wiring the same lift carried.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionState, SavedSession, DetachedRemote } from '../../../src/shared/types'
import { IDENTITY_COLOR_KEYS } from '../../../src/shared/identity-colors'

const save = vi.fn(async () => true)
;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  session: { save, clear: vi.fn(async () => true), load: vi.fn(), hasSaved: vi.fn() },
}

const { restoreSavedSessions } = await import('../../../src/renderer/session-persistence')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { useAccountGateStore } = await import('../../../src/renderer/stores/accountGateStore')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useDetachedRemotesStore } = await import('../../../src/renderer/stores/detachedRemotesStore')
const { useCommandBarStore } = await import('../../../src/renderer/stores/commandBarStore')
const { shouldUseResumePicker } = await import('../../../src/renderer/utils/resumePicker')

const KEY = IDENTITY_COLOR_KEYS[0]
const saved = (o: Partial<SavedSession> & { id: string }): SavedSession => ({
  label: o.id,
  workingDirectory: 'C:/work',
  color: '#89B4FA',
  identityColorKey: KEY, // already keyed: the colour migration leaves it alone
  sessionType: 'local',
  provider: 'claude',
  ...o,
})
const state = (sessions: SavedSession[], extra: Partial<SessionState> = {}): SessionState => ({
  sessions,
  activeSessionId: sessions[0]?.id ?? null,
  savedAt: 1_700_000_000_000,
  ...extra,
})
const remote: DetachedRemote = {
  sessionId: 'left-1', configId: 'cfg-9', host: 'pi.local', username: 'mong', remotePath: '~/work',
  mux: 'tmux', label: 'pi', detachedAt: 1_700_000_000_000,
}
// configId null = a session with NO saved config (undefined would take the default)
const ssh = (id: string, sshConfig: Partial<NonNullable<SavedSession['sshConfig']>>, configId: string | null = 'cfg-1'): SavedSession =>
  saved({
    id,
    configId: configId ?? undefined,
    sessionType: 'ssh',
    sshConfig: { host: 'h', port: 22, username: 'u', remotePath: '~', hasPassword: false, ...sshConfig } as SavedSession['sshConfig'],
  })

const deps = () => ({
  probeGoneSessions: vi.fn(async (_s: Array<{ id: string; configId?: string }>) => [] as string[]),
  pingAllDetachedHosts: vi.fn(async () => {}),
})
const ref = () => ({ current: true })
const originalRestore = useSessionStore.getState().restoreSessions
const updateSettings = vi.fn(async () => undefined)
const reconcile = vi.fn()

beforeEach(() => {
  save.mockClear()
  save.mockResolvedValue(true)
  updateSettings.mockClear()
  reconcile.mockClear()
  useSessionStore.setState({ sessions: [], activeSessionId: null, isRestoring: true, restoreSessions: originalRestore })
  useAccountGateStore.setState({ queue: [], predetermined: [], restored: [] })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, updateSettings })
  useDetachedRemotesStore.setState({ entries: [] })
  useCommandBarStore.setState({ reconcile })
})

describe('restoreSavedSessions -- the restore lands', () => {
  it('puts the saved sessions in the store, active id included, and reports success', async () => {
    const r = ref()
    const ok = await restoreSavedSessions(state([saved({ id: 'a' }), saved({ id: 'b' })], { activeSessionId: 'b' }), r, deps())
    expect(ok).toBe(true)
    const s = useSessionStore.getState()
    expect(s.sessions.map((x) => x.id)).toEqual(['a', 'b'])
    expect(s.activeSessionId).toBe('b')
    expect(s.isRestoring).toBe(false)
  })

  it('MUTANT 1: clears the unsettled ref once the restore has landed (a zero-session close may then clear the file)', async () => {
    const r = ref()
    await restoreSavedSessions(state([saved({ id: 'a' })]), r, deps())
    expect(r.current).toBe(false)
  })

  it('MUTANT 2: marks every restored session as restored-this-run (#446), whatever the resume-account mode', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, resumeAccountMode: 'ask' } })
    await restoreSavedSessions(state([saved({ id: 'a' }), saved({ id: 'b' })]), ref(), deps())
    const gate = useAccountGateStore.getState()
    expect(gate.wasRestored('a')).toBe(true)
    expect(gate.wasRestored('b')).toBe(true)
  })

  it("predetermines the account under the default 'auto-last' and NOT under 'ask' (#446)", async () => {
    await restoreSavedSessions(state([saved({ id: 'a' })]), ref(), deps())
    expect(useAccountGateStore.getState().consumePredetermined('a')).toBe(true)

    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, resumeAccountMode: 'ask' } })
    await restoreSavedSessions(state([saved({ id: 'b' })]), ref(), deps())
    expect(useAccountGateStore.getState().consumePredetermined('b')).toBe(false)
    expect(useAccountGateStore.getState().wasRestored('b')).toBe(true)
  })

  it('MUTANT 4: fires ONE reachability pass over the rehydrated left-running registry', async () => {
    const d = deps()
    await restoreSavedSessions(state([saved({ id: 'a' })], { detachedRemotes: [remote] }), ref(), d)
    expect(d.pingAllDetachedHosts).toHaveBeenCalledTimes(1)
    expect(useDetachedRemotesStore.getState().entries).toEqual([remote])
  })

  it('persists the restored set immediately (#397: no empty gap on disk) and tolerates a failed save', async () => {
    await restoreSavedSessions(state([saved({ id: 'a' })], { detachedRemotes: [remote] }), ref(), deps())
    expect(save).toHaveBeenCalledTimes(1)
    const written = save.mock.calls[0][0] as unknown as SessionState
    expect(written.sessions.map((s) => s.id)).toEqual(['a'])
    expect(written.detachedRemotes).toEqual([remote])

    save.mockRejectedValueOnce(new Error('disk'))
    const r = ref()
    await expect(restoreSavedSessions(state([saved({ id: 'b' })]), r, deps())).resolves.toBe(true)
    expect(r.current).toBe(false)
  })

  it('sweeps per-session tool hides for the sessions that came back (ADR-018 M3)', async () => {
    await restoreSavedSessions(state([saved({ id: 'a' }), saved({ id: 'b' })]), ref(), deps())
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(reconcile).toHaveBeenCalledWith(['a', 'b'])
  })

  it('marks the resume picker only for a local, non-shell session with no exact-conversation target', async () => {
    // The picker set is module-level and never cleared, so every id read here
    // is unique to this case (other cases restore 'a'/'b' and leave them in it).
    await restoreSavedSessions(
      state([
        saved({ id: 'pick-local' }),
        saved({ id: 'pick-shell', shellOnly: true }),
        saved({ id: 'pick-exact', resumeUuid: 'u', resumeCwd: 'F:/wt' }),
        ssh('pick-ssh', {}),
      ]),
      ref(),
      deps(),
    )
    expect(shouldUseResumePicker('pick-local')).toBe(true)
    expect(shouldUseResumePicker('pick-shell')).toBe(false)
    expect(shouldUseResumePicker('pick-exact')).toBe(false)
    expect(shouldUseResumePicker('pick-ssh')).toBe(false)
    // the exact target rides the record for TerminalView to consume at spawn
    expect(useSessionStore.getState().getSession('pick-exact')?.resumeUuid).toBe('u')
  })

  it('reads Claude fields from claudeOptions and carries the provider-shape fields (#397 Group 4)', async () => {
    await restoreSavedSessions(
      state([saved({ id: 'a', kind: 'ask', claudeOptions: { model: 'opus', permissionMode: 'plan', extraArgs: '--verbose', loggingEnabled: false } })]),
      ref(),
      deps(),
    )
    const s = useSessionStore.getState().getSession('a')!
    expect(s.kind).toBe('ask')
    expect(s.model).toBe('opus')
    expect(s.permissionMode).toBe('plan')
    expect(s.extraArgs).toBe('--verbose')
    expect(s.loggingEnabled).toBe(false)
    expect(s.status).toBe('idle')
  })

  it('raises the colour-migration notice once when a record had to be keyed, never when it is dismissed', async () => {
    await restoreSavedSessions(state([saved({ id: 'a', identityColorKey: undefined, color: '#89B4FA' })]), ref(), deps())
    expect(updateSettings).toHaveBeenCalledWith({ colourMigrationNoticePending: true })
    expect(useSessionStore.getState().getSession('a')?.identityColorKey).toBeDefined()

    updateSettings.mockClear()
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, colourMigrationNoticeDismissed: true } })
    await restoreSavedSessions(state([saved({ id: 'b', identityColorKey: undefined, color: '#89B4FA' })]), ref(), deps())
    expect(updateSettings).not.toHaveBeenCalled()
  })
})

describe('restoreSavedSessions -- the persistent-SSH liveness probe', () => {
  it('MUTANT 3: probes ONLY persistent SSH sessions -- ssh, with a config, and not detachable:false', async () => {
    const d = deps()
    await restoreSavedSessions(
      state([
        ssh('ssh-persistent', {}),                               // detachable absent = persistent
        ssh('ssh-explicit', { detachable: true }),
        ssh('ssh-ephemeral', { detachable: false }),
        ssh('ssh-no-config', {}, null),
        saved({ id: 'local' }),
      ]),
      ref(),
      d,
    )
    await vi.waitFor(() => expect(d.probeGoneSessions).toHaveBeenCalledTimes(1))
    expect(d.probeGoneSessions).toHaveBeenCalledWith([
      { id: 'ssh-persistent', configId: 'cfg-1' },
      { id: 'ssh-explicit', configId: 'cfg-1' },
    ])
  })

  it('does not probe at all when nothing persistent was restored', async () => {
    const d = deps()
    await restoreSavedSessions(state([saved({ id: 'local' }), ssh('ssh-ephemeral', { detachable: false })]), ref(), d)
    await new Promise((r) => setTimeout(r, 0))
    expect(d.probeGoneSessions).not.toHaveBeenCalled()
  })

  it('flags a session the host confirms gone, and ignores one the user closed while the probe was out', async () => {
    const d = deps()
    // A deferred answer: the probe is still out when the user closes a tab
    // (an immediately-resolved mock would flag both before the close happens
    // and never exercise the guard -- code-quality review, 2.1.1).
    let answer!: (ids: string[]) => void
    d.probeGoneSessions.mockImplementationOnce(() => new Promise<string[]>((r) => { answer = r }))
    await restoreSavedSessions(state([ssh('ssh-gone', {}), ssh('ssh-closed', {}), ssh('ssh-live', {})]), ref(), d)
    await vi.waitFor(() => expect(d.probeGoneSessions).toHaveBeenCalledTimes(1))
    // closed between restore and the probe returning
    useSessionStore.setState({ sessions: useSessionStore.getState().sessions.filter((s) => s.id !== 'ssh-closed') })
    const updates: string[] = []
    const realUpdate = useSessionStore.getState().updateSession
    useSessionStore.setState({ updateSession: (id, u) => { updates.push(id); realUpdate(id, u) } })
    answer(['ssh-gone', 'ssh-closed'])
    await vi.waitFor(() => expect(useSessionStore.getState().getSession('ssh-gone')?.sshRemoteReattachGone).toBe(true))
    expect(updates).toEqual(['ssh-gone'])
    expect(useSessionStore.getState().getSession('ssh-live')?.sshRemoteReattachGone).toBeUndefined()
    expect(useSessionStore.getState().getSession('ssh-closed')).toBeUndefined()
    useSessionStore.setState({ updateSession: realUpdate })
  })
})

describe('restoreSavedSessions -- the restore does NOT land', () => {
  it('reports failure and leaves the unsettled ref set, so a close keeps the saved file', async () => {
    useSessionStore.setState({ restoreSessions: () => { throw new Error('store exploded') } })
    const r = ref()
    const d = deps()
    const ok = await restoreSavedSessions(state([saved({ id: 'a' })], { detachedRemotes: [remote] }), r, d)
    expect(ok).toBe(false)
    expect(r.current).toBe(true)
    expect(save).not.toHaveBeenCalled()
    expect(d.pingAllDetachedHosts).not.toHaveBeenCalled()
  })
})
