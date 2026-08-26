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

  it('paneHostSession: preferred > active > any eligible; ssh and shell-only never host', () => {
    expect(paneHostSession('s-local')).toBe('s-local')
    expect(paneHostSession('s-ssh')).toBe('s-local') // preferred ineligible -> active
    expect(paneHostSession()).toBe('s-local')
    useSessionStore.setState({ sessions: [], activeSessionId: null } as never)
    expect(paneHostSession()).toBeNull()
  })
})
