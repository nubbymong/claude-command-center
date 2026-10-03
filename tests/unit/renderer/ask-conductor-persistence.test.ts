// @vitest-environment jsdom
/**
 * The two persistence fences around Ask Conductor.
 *
 *  1. `kind` MUST round-trip, or a restored Ask session comes back as an
 *     ordinary config-less session: plain tab dot, loose in the project list,
 *     no dock. Same silent-drop class as the loggingEnabled / detachable bugs,
 *     and buildSessionState is a field-by-field ALLOWLIST, so a new field is
 *     dropped by default.
 *
 *  2. `askPrompt` MUST NOT round-trip. That same allowlist is the entire
 *     mechanism keeping the user's typed question out of session-state.json --
 *     and out of the NEXT launch, which would re-submit it unasked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useSessionStore, type Session } from '../../../src/renderer/stores/sessionStore'
import { buildSessionState } from '../../../src/renderer/session-persistence'
import { launchAskConductor, useAskErrorStore, _resetAskLaunchForTest, ASK_CODEX_PRESET } from '../../../src/renderer/lib/askConductor'
import { useSettingsStore, DEFAULT_SETTINGS } from '../../../src/renderer/stores/settingsStore'
import { useAccountGateStore } from '../../../src/renderer/stores/accountGateStore'

const askSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'sess-ask-1',
  kind: 'ask',
  label: 'Ask Conductor',
  workingDirectory: 'C:/res/help',
  model: '',
  color: '#5d8bf0',
  identityColorKey: 'lavender',
  status: 'idle',
  createdAt: 1714850000000,
  sessionType: 'local',
  provider: 'claude',
  ...overrides,
})

describe('session-persistence -- Ask Conductor', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [], activeSessionId: null, isRestoring: false })
  })

  it('serializes kind so the session comes back AS an Ask session', () => {
    useSessionStore.setState({ sessions: [askSession()], activeSessionId: 'sess-ask-1', isRestoring: false })
    expect(buildSessionState().sessions[0].kind).toBe('ask')
  })

  it('leaves kind unset for an ordinary project session', () => {
    useSessionStore.setState({
      sessions: [askSession({ id: 'proj', kind: undefined, configId: 'cfg1' })],
      activeSessionId: 'proj',
      isRestoring: false,
    })
    expect(buildSessionState().sessions[0].kind).toBeUndefined()
    expect(buildSessionState().sessions[0].configId).toBe('cfg1')
  })

  it('never writes an Ask session with a configId', () => {
    useSessionStore.setState({ sessions: [askSession()], activeSessionId: 'sess-ask-1', isRestoring: false })
    expect(buildSessionState().sessions[0].configId).toBeUndefined()
  })

  it('NEVER serializes askPrompt -- not the key, not the text', () => {
    const question = 'what is the $ cost of running two accounts?'
    useSessionStore.setState({
      sessions: [askSession({ askPrompt: question })],
      activeSessionId: 'sess-ask-1',
      isRestoring: false,
    })
    const state = buildSessionState()
    expect('askPrompt' in state.sessions[0]).toBe(false)
    // Belt and braces: the text must not reach disk under ANY key, including one
    // added later inside claudeOptions or a spread that reintroduces it.
    expect(JSON.stringify(state)).not.toContain(question)
    expect(JSON.stringify(state)).not.toContain('askPrompt')
  })
})

// [host] WP2 PR 4, P4.3: a revive is a new start, so it reads the provider
// again, and it has the help folder rebuilt first like any start.
describe('a revive of a closed Ask tab (P4.3)', () => {
  const workspace = vi.fn(() => Promise.resolve('C:/res/help2'))
  const ptyWrite = vi.fn()
  const BOTH = { claudeEnabled: true, codexEnabled: true, codexAnswered: true }
  const dead = (over: Partial<Session> = {}): Session => askSession({ ptyExited: true, profileId: 'profile-a', ...over })

  beforeEach(() => {
    workspace.mockClear()
    ptyWrite.mockClear()
    _resetAskLaunchForTest()
    useAskErrorStore.setState({ error: null })
    useAccountGateStore.setState({ predetermined: [] } as never)
    ;(globalThis as any).window.electronAPI = { help: { workspace }, pty: { write: ptyWrite } }
  })
  afterEach(() => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
  })
  const set = (s: Record<string, unknown>) => useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...s } as never })
  const after = () => useSessionStore.getState().sessions[0]

  it('the choice changed to Codex since the tab ran: it starts on Codex, with Codex options, and none of Claude\'s account', async () => {
    set({ ...BOTH, askConductorProvider: 'codex' })
    useSessionStore.setState({ sessions: [dead({ resumeUuid: 'u', resumeCwd: 'C:/res/help' })], activeSessionId: null, isRestoring: false })
    expect(await launchAskConductor('again?')).toBe('sess-ask-1')
    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(after()).toMatchObject({ id: 'sess-ask-1', kind: 'ask', provider: 'codex', askPrompt: 'again?', workingDirectory: 'C:/res/help2' })
    expect(after().codexOptions).toEqual({ permissionsPreset: ASK_CODEX_PRESET })
    expect(after().profileId).toBeUndefined()
    expect(after().resumeUuid).toBeUndefined()
    expect(after().ptyExited).toBeUndefined()
    // A different assistant: its account is decided as on a first launch.
    expect(useAccountGateStore.getState().predetermined).not.toContain('sess-ask-1')
  })

  it('Codex switched off since a Codex tab ran: it starts on Claude Code, without the Codex options or account', async () => {
    set({})
    useSessionStore.setState({ sessions: [dead({ provider: 'codex', codexOptions: { permissionsPreset: 'standard' }, providerAccountId: 'acct-1', profileId: undefined })], activeSessionId: null, isRestoring: false })
    await launchAskConductor()
    expect(after().provider).toBe('claude')
    expect(after().codexOptions).toBeUndefined()
    expect(after().providerAccountId).toBeUndefined()
  })

  it('the same assistant: kept as it was, the account not asked again (as before)', async () => {
    set(BOTH)
    useSessionStore.setState({ sessions: [dead()], activeSessionId: null, isRestoring: false })
    await launchAskConductor('q')
    expect(after()).toMatchObject({ provider: 'claude', profileId: 'profile-a', askPrompt: 'q' })
    expect(useAccountGateStore.getState().predetermined).toContain('sess-ask-1')
  })

  it('every revive has the help folder rebuilt first; a failure revives nothing and says why', async () => {
    set({})
    useSessionStore.setState({ sessions: [dead()], activeSessionId: null, isRestoring: false })
    await launchAskConductor()
    expect(workspace).toHaveBeenCalledTimes(1)

    _resetAskLaunchForTest()
    const before = dead({ createdAt: 7 })
    useSessionStore.setState({ sessions: [before], activeSessionId: null, isRestoring: false })
    ;(globalThis as any).window.electronAPI.help.workspace = () => Promise.resolve(null)
    expect(await launchAskConductor('q')).toBe('')
    expect(useSessionStore.getState().sessions).toEqual([before])
    expect(useAskErrorStore.getState().error).toMatch(/resources directory/i)
  })

  it('what a revive writes back is still never the question', async () => {
    set({ ...BOTH, askConductorProvider: 'codex' })
    useSessionStore.setState({ sessions: [dead()], activeSessionId: null, isRestoring: false })
    await launchAskConductor('secret question text')
    const state = buildSessionState()
    expect(JSON.stringify(state)).not.toContain('secret question text')
    expect(state.sessions[0].provider).toBe('codex')
  })
})
