// @vitest-environment jsdom
/**
 * The two global "where does claude.ai open" knobs (owner call 2026-08-26):
 *  - defaults are today's behaviour (the dedicated window) for BOTH;
 *  - sign-in honours a beta-era per-account choice until the global is set;
 *  - openArtifactsPerSetting routes to the pane only when the setting says so
 *    AND a session can host it, and never dead-ends (window fallback).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  resolveArtifactsOpenTarget,
  resolveSignInOpenTarget,
  paneHostSession,
  openArtifactsPerSetting,
} from '../../../src/renderer/lib/claude-web-targets'
import { useSettingsStore } from '../../../src/renderer/stores/settingsStore'
import { useSessionStore } from '../../../src/renderer/stores/sessionStore'
import { useWebviewStore } from '../../../src/renderer/stores/webviewStore'

describe('resolveArtifactsOpenTarget', () => {
  it('defaults to window — absent, and anything unexpected, is the old behaviour', () => {
    expect(resolveArtifactsOpenTarget({})).toBe('window')
    expect(resolveArtifactsOpenTarget({ artifactsOpenTarget: 'window' })).toBe('window')
    expect(resolveArtifactsOpenTarget({ artifactsOpenTarget: 'oops' as never })).toBe('window')
    expect(resolveArtifactsOpenTarget({ artifactsOpenTarget: 'pane' })).toBe('pane')
  })
})

describe('resolveSignInOpenTarget', () => {
  it('the global wins in both directions once set', () => {
    expect(resolveSignInOpenTarget({ signInOpenTarget: 'pane' }, false)).toBe('pane')
    expect(resolveSignInOpenTarget({ signInOpenTarget: 'window' }, true)).toBe('window')
  })
  it('absent global: a beta-era per-account internal-pane choice is preserved', () => {
    expect(resolveSignInOpenTarget({}, true)).toBe('pane')
    expect(resolveSignInOpenTarget({}, false)).toBe('window')
  })
})

describe('openArtifactsPerSetting', () => {
  const openArtifactsIpc = vi.fn().mockResolvedValue({ ok: true })
  const openAccountPane = vi.fn()

  beforeEach(() => {
    openArtifactsIpc.mockClear()
    openAccountPane.mockClear()
    ;(window as any).electronAPI = { accountWeb: { openArtifacts: openArtifactsIpc } }
    useWebviewStore.setState({ openAccountPane } as never)
    useSessionStore.setState({
      sessions: [
        { id: 's-ssh', shellOnly: false, sessionType: 'ssh' },
        { id: 's-local', shellOnly: false, sessionType: 'local' },
        { id: 's-shell', shellOnly: true, sessionType: 'local' },
      ],
      activeSessionId: 's-local',
    } as never)
  })

  it('window (the default): the existing IPC path, pane untouched', () => {
    useSettingsStore.setState((st) => ({ settings: { ...st.settings, artifactsOpenTarget: undefined } }))
    openArtifactsPerSetting('profile-1', 's-local')
    expect(openArtifactsIpc).toHaveBeenCalledWith('profile-1')
    expect(openAccountPane).not.toHaveBeenCalled()
  })

  it('pane: hosts in the preferred session and never calls the window IPC', () => {
    useSettingsStore.setState((st) => ({ settings: { ...st.settings, artifactsOpenTarget: 'pane' } }))
    openArtifactsPerSetting('profile-1', 's-local')
    expect(openAccountPane).toHaveBeenCalledWith('s-local', 'profile-1')
    expect(openArtifactsIpc).not.toHaveBeenCalled()
  })

  it('pane with no eligible host falls back to the window — the action never dead-ends', () => {
    useSettingsStore.setState((st) => ({ settings: { ...st.settings, artifactsOpenTarget: 'pane' } }))
    useSessionStore.setState({ sessions: [{ id: 's-shell', shellOnly: true, sessionType: 'local' }], activeSessionId: 's-shell' } as never)
    openArtifactsPerSetting('profile-1')
    expect(openAccountPane).not.toHaveBeenCalled()
    expect(openArtifactsIpc).toHaveBeenCalledWith('profile-1')
  })

  it('adv LOW-1: pane hosts in the caller’s OWN session (SSH included now) and never in a DIFFERENT session', () => {
    useSettingsStore.setState((st) => ({ settings: { ...st.settings, artifactsOpenTarget: 'pane' } }))
    // The caller’s own session is SSH (now eligible — the pane is a local
    // webview and the SSH account maps to a local profile). Another local
    // session (a DIFFERENT account) is active. requirePreferred still binds
    // hosting to the caller’s OWN session, so the pane opens in s-mine-ssh and
    // NEVER in s-other-local — the security property the test guards.
    useSessionStore.setState({
      sessions: [
        { id: 's-mine-ssh', shellOnly: false, sessionType: 'ssh' },
        { id: 's-other-local', shellOnly: false, sessionType: 'local' },
      ],
      activeSessionId: 's-other-local',
    } as never)
    openArtifactsPerSetting('profile-1', 's-mine-ssh')
    expect(openAccountPane).toHaveBeenCalledWith('s-mine-ssh', 'profile-1')
    expect(openAccountPane).not.toHaveBeenCalledWith('s-other-local', expect.anything())
    expect(openArtifactsIpc).not.toHaveBeenCalled()
  })

  it('paneHostSession: an SSH Claude session CAN host (setting respected for remote); shell-only never does', () => {
    expect(paneHostSession('s-local')).toBe('s-local')
    // SSH is now eligible: a preferred SSH id wins, and requirePreferred returns it.
    expect(paneHostSession('s-ssh')).toBe('s-ssh')
    expect(paneHostSession('s-ssh', true)).toBe('s-ssh')
    expect(paneHostSession('s-local', true)).toBe('s-local')
    expect(paneHostSession()).toBe('s-local') // active preferred over first-eligible
    // Shell-only is still never a host.
    expect(paneHostSession('s-shell', true)).toBeNull()
    useSessionStore.setState({ sessions: [], activeSessionId: null } as never)
    expect(paneHostSession()).toBeNull()
  })
})
