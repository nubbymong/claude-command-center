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
// Peripheral children — not under test here.
vi.mock('../../../src/renderer/components/NotesBar', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/TipPill', () => ({ default: () => null }))

const { default: SessionHeader } = await import('../../../src/renderer/components/SessionHeader')
import type { Session } from '../../../src/renderer/stores/sessionStore'
import { useAccountAuthStore, _resetAccountAuthForTest } from '../../../src/renderer/stores/accountAuthStore'

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
    expect(container.textContent).toContain('nubbymong/web')
    expect(container.textContent).toContain('connected')
  })

  it('renders no repo slug when there is no GitHub integration', () => {
    render(makeSession({ githubIntegration: undefined }))
    expect(container.textContent).not.toContain('nubbymong')
  })

  it('shows the Claude Code + claude.ai pills with this account status for a local Claude session', () => {
    useAccountAuthStore.setState({ byProfile: { 'profile-x': { cliAuthed: true, web: 'active', loading: false, fetchedAt: 1 } } })
    render(makeSession({ profileId: 'profile-x', provider: 'claude', sessionType: 'local' }))
    expect(container.textContent).toContain('Claude Code')
    expect(container.textContent).toContain('signed in')
    expect(container.textContent).toContain('claude.ai')
    expect(container.textContent).toContain('connected')
  })

  it('shows an expired claude.ai and signed-out Claude Code', () => {
    useAccountAuthStore.setState({ byProfile: { 'profile-y': { cliAuthed: false, web: 'expired', loading: false, fetchedAt: 1 } } })
    render(makeSession({ profileId: 'profile-y', provider: 'claude', sessionType: 'local' }))
    expect(container.textContent).toContain('signed out')
    expect(container.textContent).toContain('expired')
  })

  it('does NOT show the auth pills for an SSH session (remote creds)', () => {
    useAccountAuthStore.setState({ byProfile: { 'profile-z': { cliAuthed: true, web: 'active', loading: false, fetchedAt: 1 } } })
    render(makeSession({ profileId: 'profile-z', provider: 'claude', sessionType: 'ssh', sshConfig: { host: 'h', port: 22, username: 'u', remotePath: '~' } as any }))
    expect(container.textContent).not.toContain('Claude Code')
    expect(container.textContent).not.toContain('claude.ai')
  })
})
