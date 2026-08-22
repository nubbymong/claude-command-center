// @vitest-environment jsdom
/**
 * SessionHeader — the single consolidated bar below the tabs. Covers the
 * work-name display (customName || label) and the orientation info folded in
 * from the former RepoBreadcrumb strip: working directory + GitHub repo
 * slug/connection. (Replaces the deleted repo-breadcrumb tests.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))
vi.mock('../../../src/renderer/hooks/useTypography', () => ({ useRegionTypography: () => ({}) }))

const { default: SessionHeader } = await import('../../../src/renderer/components/SessionHeader')
import type { Session } from '../../../src/renderer/stores/sessionStore'
import { useAccountAuthStore, _resetAccountAuthForTest } from '../../../src/renderer/stores/accountAuthStore'
import { useAccountProfilesStore } from '../../../src/renderer/stores/accountProfilesStore'

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: 's1', label: 'web', workingDirectory: '/home/me/projects/web', model: 'sonnet',
    color: '#ff0000', status: 'idle', createdAt: 0, sessionType: 'local', configId: 'cfg-1', ...over,
  } as Session
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  _resetAccountAuthForTest()
  // The auth pills' effect calls this on mount; resolve it so it never errors.
  ;(globalThis as any).window.electronAPI = {
    accountWeb: { status: vi.fn(async () => ({ ok: true, cli: { authenticated: false }, web: { status: 'none' } })) },
  }
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})
const render = (s: Session) => act(() => { root.render(<SessionHeader session={s} />) })

describe('SessionHeader', () => {
  it('shows the config label when no custom name', () => {
    render(makeSession())
    expect(container.textContent).toContain('web')
  })

  it('shows customName over label when set', () => {
    render(makeSession({ customName: 'IM-8315 keychain' }))
    expect(container.textContent).toContain('IM-8315 keychain')
  })

  it('renders the working directory path (folded in from RepoBreadcrumb)', () => {
    render(makeSession())
    expect(container.textContent).toContain('/home/me/projects/web')
  })

  it('renders repo slug + connected state when GitHub integration is enabled', () => {
    render(makeSession({ githubIntegration: { enabled: true, repoSlug: 'nubbymong/web', autoDetected: true } as any }))
    // The repo slug is on HOVER now (title), not inline; the pill reads "GitHub".
    const gh = container.querySelector('[data-testid="session-pill-github"]')
    expect(gh).not.toBeNull()
    expect(gh?.getAttribute('title')).toContain('nubbymong/web')
    expect(container.textContent).toContain('GitHub')
    expect(container.textContent).not.toContain('nubbymong/web') // not inline
  })

  it('renders no repo slug when there is no GitHub integration', () => {
    render(makeSession({ githubIntegration: undefined }))
    expect(container.textContent).not.toContain('nubbymong')
  })

  it('shows the Claude Code + claude.ai pills with this account status for a local Claude session', () => {
    useAccountAuthStore.setState({ byProfile: { 'profile-x': { cliAuthed: true, web: 'active', loading: false, fetchedAt: 1 } } })
    render(makeSession({ profileId: 'profile-x', provider: 'claude', sessionType: 'local' }))
    // The good state is a green dot + label, NO word (matches the title-bar pills:
    // a word only when action is needed).
    expect(container.querySelector('[data-testid="session-pill-claudecode"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="session-pill-claudeai"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="session-pill-account"]')).not.toBeNull()
    expect(container.textContent).toContain('Claude Code')
    expect(container.textContent).toContain('claude.ai')
    expect(container.textContent).not.toContain('signed out')
    expect(container.textContent).not.toContain('not connected')
  })

  it('shows an expired claude.ai and signed-out Claude Code', () => {
    useAccountAuthStore.setState({ byProfile: { 'profile-y': { cliAuthed: false, web: 'expired', loading: false, fetchedAt: 1 } } })
    render(makeSession({ profileId: 'profile-y', provider: 'claude', sessionType: 'local' }))
    expect(container.textContent).toContain('signed out')
    expect(container.textContent).toContain('expired')
  })

  it('shows "…" (not "signed out") before the first status read completes', async () => {
    // First render precedes the fetch effect; then the fetch is in flight. Neither
    // state may be painted as a definite "signed out"/"not connected".
    let resolveStatus: (v: unknown) => void = () => {}
    ;(window.electronAPI.accountWeb.status as any).mockImplementation(() => new Promise((r) => { resolveStatus = r }))
    render(makeSession({ profileId: 'profile-p', provider: 'claude', sessionType: 'local' }))
    expect(container.textContent).toContain('Claude Code')
    expect(container.textContent).not.toContain('signed out')
    expect(container.textContent).not.toContain('not connected')
    expect(container.textContent).toContain('…')
    // Once the read lands, the good state shows the dot + label, no word.
    await act(async () => { resolveStatus({ ok: true, cli: { authenticated: true }, web: { status: 'active' } }) })
    expect(container.textContent).not.toContain('…')
    expect(container.textContent).not.toContain('signed out')
    expect(container.textContent).not.toContain('not connected')
  })

  it('shows "unknown" (not "signed out") when the first status read fails', async () => {
    ;(window.electronAPI.accountWeb.status as any).mockImplementation(async () => ({ ok: false, error: 'probe crashed' }))
    await act(async () => { root.render(<SessionHeader session={makeSession({ profileId: 'profile-q', provider: 'claude', sessionType: 'local' })} />) })
    expect(container.textContent).not.toContain('signed out')
    expect(container.textContent).not.toContain('not connected')
    expect(container.textContent).toContain('unknown')
    expect(container.querySelector('[data-testid="session-pill-claudecode"]')?.getAttribute('title')).toContain('probe crashed')
  })

  it('surfaces a failed refresh in the tooltip even after a prior successful read (stale status is not silent)', async () => {
    // A prior success is on record; the mount's refresh then FAILS. The pills
    // keep the last-known text/colour, but the error must appear in the tooltip
    // so the stale status is not invisible.
    useAccountAuthStore.setState({ byProfile: { 'profile-e': { cliAuthed: true, web: 'active', loading: false, fetchedAt: 5 } } })
    ;(window.electronAPI.accountWeb.status as any).mockImplementation(async () => ({ ok: false, error: 'probe crashed' }))
    await act(async () => { root.render(<SessionHeader session={makeSession({ profileId: 'profile-e', provider: 'claude', sessionType: 'local' })} />) })
    // last-known GOOD status still shown (dot, no problem word)...
    expect(container.textContent).not.toContain('signed out')
    expect(container.textContent).not.toContain('not connected')
    // ...and the error is in the tooltip.
    expect(container.querySelector('[data-testid="session-pill-claudecode"]')?.getAttribute('title')).toContain('probe crashed')
  })

  it('the account pill shows the session account name (resolved from the profile)', () => {
    useAccountProfilesStore.setState({ profiles: [{ id: 'profile-x', name: 'Work', accountEmail: 'me@work.co' } as any] })
    useAccountAuthStore.setState({ byProfile: { 'profile-x': { cliAuthed: true, web: 'active', loading: false, fetchedAt: 1 } } })
    render(makeSession({ profileId: 'profile-x', provider: 'claude', sessionType: 'local' }))
    const acct = container.querySelector('[data-testid="session-pill-account"]')
    expect(acct).not.toBeNull()
    expect(acct?.textContent).toContain('Work')
    expect(acct?.getAttribute('title')).toContain('me@work.co')
    useAccountProfilesStore.setState({ profiles: [] })
  })

  it('an SSH session still shows the GitHub pill (on hover) but not the Claude pills', () => {
    render(makeSession({ provider: 'claude', sessionType: 'ssh', sshConfig: { host: 'h', port: 22, username: 'u', remotePath: '~' } as any, githubIntegration: { enabled: true, repoSlug: 'nubbymong/web', autoDetected: true } as any }))
    expect(container.querySelector('[data-testid="session-pill-github"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="session-pill-claudecode"]')).toBeNull()
    expect(container.querySelector('[data-testid="session-pill-account"]')).toBeNull()
  })

  it('does NOT show the auth pills for an SSH session (remote creds)', () => {
    useAccountAuthStore.setState({ byProfile: { 'profile-z': { cliAuthed: true, web: 'active', loading: false, fetchedAt: 1 } } })
    render(makeSession({ profileId: 'profile-z', provider: 'claude', sessionType: 'ssh', sshConfig: { host: 'h', port: 22, username: 'u', remotePath: '~' } as any }))
    expect(container.textContent).not.toContain('Claude Code')
    expect(container.textContent).not.toContain('claude.ai')
  })
})
