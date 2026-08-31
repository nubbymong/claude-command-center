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
    expect(gh?.querySelector('svg')).toBeNull() // dot + word only — no octocat logo (owner, 2026-08-24)
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

  it('the account pill prefers the LIVE captured account over a diverged profile label', () => {
    // WINDOWS_1 staging VM, 2026-08-30: a profile whose stored label disagrees
    // with what is actually signed in inside its dir must not win the pill —
    // the pill names what the session RUNS AS.
    useAccountProfilesStore.setState({ profiles: [{ id: 'profile-x', name: 'Work', accountEmail: 'label@fake.dev' } as any] })
    useAccountAuthStore.setState({ byProfile: { 'profile-x': { cliAuthed: true, web: 'active', loading: false, fetchedAt: 1 } } })
    render(makeSession({ profileId: 'profile-x', provider: 'claude', sessionType: 'local', accountEmail: 'real@x.com' }))
    const acct = container.querySelector('[data-testid="session-pill-account"]')
    expect(acct).not.toBeNull()
    expect(acct?.getAttribute('title')).toContain('real@x.com')
    expect(acct?.getAttribute('title')).not.toContain('label@fake.dev')
    // The profile's friendly name must not relabel a diverged account.
    expect(acct?.textContent).not.toContain('Work')
    useAccountProfilesStore.setState({ profiles: [] })
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
    // No remote account known (no live tick, no setup sentinel) — no account pill.
    expect(container.querySelector('[data-testid="session-pill-account"]')).toBeNull()
  })

  // Phase 3 (harmonise-remote): the SSH header carries the ACCOUNT pill once a
  // remote account is known — live accountEmail (tunnel /status) preferred,
  // setup-sentinel sshRemoteAccount as fallback. Signed-in state is FOLDED into
  // the pill (it exists iff the remote reports an account): no Claude Code /
  // claude.ai pills, and the old mauve remote-account pill is retired.
  it('SSH: shows the account pill from the setup-sentinel fallback (sshRemoteAccount)', () => {
    render(makeSession({ provider: 'claude', sessionType: 'ssh', sshConfig: { host: 'h', port: 22, username: 'u', remotePath: '~' } as any, sshRemoteAccount: 'remote@x.com' }))
    const acct = container.querySelector('[data-testid="session-pill-account"]')
    expect(acct).not.toBeNull()
    expect(acct?.getAttribute('title')).toContain('remote@x.com')
    expect(container.querySelector('[data-testid="ssh-remote-account-pill"]')).toBeNull()
    expect(container.querySelector('[data-testid="session-pill-claudecode"]')).toBeNull()
    expect(container.querySelector('[data-testid="session-pill-claudeai"]')).toBeNull()
  })

  it('SSH: the live tunnel accountEmail wins over the setup-sentinel snapshot', () => {
    render(makeSession({ provider: 'claude', sessionType: 'ssh', sshConfig: { host: 'h', port: 22, username: 'u', remotePath: '~' } as any, accountEmail: 'live@x.com', sshRemoteAccount: 'stale@x.com' }))
    const acct = container.querySelector('[data-testid="session-pill-account"]')
    expect(acct).not.toBeNull()
    expect(acct?.getAttribute('title')).toContain('live@x.com')
    expect(acct?.getAttribute('title')).not.toContain('stale@x.com')
  })

  it('does NOT show the auth pills when the KNOWN remote account matches no local profile — even with a launch profileId (no fabricated mapping)', () => {
    useAccountProfilesStore.setState({ profiles: [{ id: 'profile-z', name: 'Work', accountEmail: 'me@work.co' } as any] })
    useAccountAuthStore.setState({ byProfile: { 'profile-z': { cliAuthed: true, web: 'active', loading: false, fetchedAt: 1 } } })
    render(makeSession({ profileId: 'profile-z', provider: 'claude', sessionType: 'ssh', sshConfig: { host: 'h', port: 22, username: 'u', remotePath: '~' } as any, accountEmail: 'stranger@nowhere.dev' }))
    // The account pill names the remote's own identity; profile-z's auth pills
    // (a DIFFERENT account) must not attach to it.
    expect(container.querySelector('[data-testid="session-pill-account"]')?.getAttribute('title')).toContain('stranger@nowhere.dev')
    expect(container.textContent).not.toContain('Claude Code')
    expect(container.textContent).not.toContain('claude.ai')
    useAccountProfilesStore.setState({ profiles: [] })
  })

  it('first connect (no remote identity yet): the launch profile stands in with a provisional title, then the reported email takes over', () => {
    useAccountProfilesStore.setState({ profiles: [{ id: 'profile-z', name: 'Work', accountEmail: 'me@work.co' } as any] })
    useAccountAuthStore.setState({ byProfile: { 'profile-z': { cliAuthed: true, web: 'active', loading: false, fetchedAt: 1 } } })
    render(makeSession({ profileId: 'profile-z', provider: 'claude', sessionType: 'ssh', sshConfig: { host: 'h', port: 22, username: 'u', remotePath: '~' } as any }))
    const acct = container.querySelector('[data-testid="session-pill-account"]')
    expect(acct).not.toBeNull()
    // Locally-sourced stand-in: captioned as the LAUNCH account, never asserted
    // as the remote's sign-in (that claim waits for the remote to report).
    expect(acct?.getAttribute('title')).toContain('me@work.co')
    expect(acct?.getAttribute('title')).toContain('Launch account')
    expect(acct?.getAttribute('title')).not.toContain('signed in on the remote host')
    expect(container.querySelector('[data-testid="session-pill-claudecode"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="session-pill-claudeai"]')).not.toBeNull()
    useAccountProfilesStore.setState({ profiles: [] })
  })

  // Bug (owner, 2026-08-31): a STANDARD SSH session showed nothing at the top —
  // no account pill, no claude.ai / Claude Code pills — while its Artifacts
  // button worked. Root cause: the header gated the whole pill set on a
  // displayed remote email, but the mapped profile (sshMappedProfileId, the same
  // signal the Artifacts button uses) had resolved via the launch-profileId
  // fallback and its accountEmail had not populated yet. The header must render
  // from the mapped profile, using its NAME until the remote reports.
  it('SSH mapped via the launch profile with NO email yet: still renders the pill set, labelled by the profile name', () => {
    useAccountProfilesStore.setState({ profiles: [{ id: 'profile-ssh', name: 'Work' } as any] }) // no accountEmail yet
    useAccountAuthStore.setState({ byProfile: { 'profile-ssh': { cliAuthed: true, web: 'active', loading: false, fetchedAt: 1 } } })
    render(makeSession({ provider: 'claude', sessionType: 'ssh', sshConfig: { host: 'h', port: 22, username: 'u', remotePath: '~' } as any, profileId: 'profile-ssh' }))
    const acct = container.querySelector('[data-testid="session-pill-account"]')
    expect(acct).not.toBeNull()
    expect(acct?.textContent).toContain('Work')
    expect(acct?.getAttribute('title')).toContain('Launch account')
    expect(container.querySelector('[data-testid="session-pill-claudecode"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="session-pill-claudeai"]')).not.toBeNull()
    useAccountProfilesStore.setState({ profiles: [] })
  })

  // harmonise-remote (owner UX, 2026-08-31): when an SSH session's signed-in
  // remote account maps to a LOCAL account profile, the claude.ai / Claude Code
  // pills apply too — those checks are local-profile-scoped and act on the
  // account identity, which is the same identity on THIS machine. The account
  // pill keeps its remote name/title; the two auth pills read the mapped profile.
  it('SSH mapped to a local profile: renders claude.ai + Claude Code pills driven by that profile', () => {
    useAccountProfilesStore.setState({ profiles: [{ id: 'profile-ssh', name: 'Work', accountEmail: 'remote@x.com' } as any] })
    useAccountAuthStore.setState({ byProfile: { 'profile-ssh': { cliAuthed: true, web: 'active', loading: false, fetchedAt: 1 } } })
    render(makeSession({ provider: 'claude', sessionType: 'ssh', sshConfig: { host: 'h', port: 22, username: 'u', remotePath: '~' } as any, accountEmail: 'remote@x.com' }))
    expect(container.querySelector('[data-testid="session-pill-account"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="session-pill-claudecode"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="session-pill-claudeai"]')).not.toBeNull()
    // The account pill keeps its remote identity/title...
    expect(container.querySelector('[data-testid="session-pill-account"]')?.getAttribute('title')).toContain('remote@x.com')
    // ...and the mapped profile's good auth state shows no problem words.
    expect(container.textContent).not.toContain('signed out')
    expect(container.textContent).not.toContain('not connected')
    useAccountProfilesStore.setState({ profiles: [] })
  })

  it('SSH mapped to a local profile: the auth pills reflect that profile\'s status (signed-out / expired)', () => {
    useAccountProfilesStore.setState({ profiles: [{ id: 'profile-ssh', name: 'Work', accountEmail: 'remote@x.com' } as any] })
    useAccountAuthStore.setState({ byProfile: { 'profile-ssh': { cliAuthed: false, web: 'expired', loading: false, fetchedAt: 1 } } })
    render(makeSession({ provider: 'claude', sessionType: 'ssh', sshConfig: { host: 'h', port: 22, username: 'u', remotePath: '~' } as any, accountEmail: 'remote@x.com' }))
    expect(container.textContent).toContain('signed out')
    expect(container.textContent).toContain('expired')
    useAccountProfilesStore.setState({ profiles: [] })
  })

  it('SSH with NO matching local profile: account pill ONLY (no claude.ai / Claude Code)', () => {
    // A profile exists, but its email does not match the remote account — so
    // there is no local auth to show and the pill stands alone.
    useAccountProfilesStore.setState({ profiles: [{ id: 'profile-other', name: 'Other', accountEmail: 'someoneelse@x.com' } as any] })
    useAccountAuthStore.setState({ byProfile: { 'profile-other': { cliAuthed: true, web: 'active', loading: false, fetchedAt: 1 } } })
    render(makeSession({ provider: 'claude', sessionType: 'ssh', sshConfig: { host: 'h', port: 22, username: 'u', remotePath: '~' } as any, accountEmail: 'remote@x.com' }))
    expect(container.querySelector('[data-testid="session-pill-account"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="session-pill-claudecode"]')).toBeNull()
    expect(container.querySelector('[data-testid="session-pill-claudeai"]')).toBeNull()
    useAccountProfilesStore.setState({ profiles: [] })
  })

  // One SSH connection pill (owner UX, 2026-08-31): kind + address in a single
  // HeaderPill, replacing the old mauve "SSH: user@host" text and the separate
  // persistent / not-persistent pills. `ssh-connection-pill` is present in BOTH
  // states; the persistent variant ALSO keeps `ssh-persistent-pill`.
  it('SSH standard session: one "SSH" connection pill showing the address (no persistent/not-persistent chrome)', () => {
    render(makeSession({ provider: 'claude', sessionType: 'ssh', sshConfig: { host: '192.168.1.5', port: 22, username: 'nick', remotePath: '~' } as any }))
    const pill = container.querySelector('[data-testid="ssh-connection-pill"]')
    expect(pill).not.toBeNull()
    expect(pill?.textContent).toContain('SSH')
    expect(pill?.textContent).toContain('nick@192.168.1.5') // address at a glance, not only on hover
    expect(pill?.textContent).not.toContain('SSH-Persistent')
    // The old text span + both persistence pills are gone.
    expect(container.textContent).not.toContain('SSH: ')
    expect(container.textContent).not.toContain('not persistent')
    expect(container.querySelector('[data-testid="ssh-nonpersistent-pill"]')).toBeNull()
    expect(container.querySelector('[data-testid="ssh-persistent-pill"]')).toBeNull()
  })

  it('SSH persistent session: the pill reads "SSH-Persistent" and still answers to both testIds', () => {
    render(makeSession({ provider: 'claude', sessionType: 'ssh', sshTmuxPersistent: true, sshConfig: { host: 'box', port: 22, username: 'u', remotePath: '~' } as any }))
    const pill = container.querySelector('[data-testid="ssh-connection-pill"]')
    expect(pill).not.toBeNull()
    expect(pill?.textContent).toContain('SSH-Persistent')
    expect(pill?.textContent).toContain('u@box')
    // Existing hook preserved for the persistent variant.
    expect(container.querySelector('[data-testid="ssh-persistent-pill"]')).not.toBeNull()
  })

  // Docker pill in the SSH cluster (harmonise-remote Phase 3): composes with the
  // persistence pill, keyed on the structured docker field, container on hover.
  it('SSH: shows the docker pill (naming the container) when the session runs in a container', () => {
    render(makeSession({ provider: 'claude', sessionType: 'ssh', sshConfig: { host: 'h', port: 22, username: 'u', remotePath: '~', dockerContainer: 'ccc-test' } as any }))
    const pill = container.querySelector('[data-testid="ssh-docker-pill"]')
    expect(pill).not.toBeNull()
    expect(pill?.getAttribute('title')).toBe('Runs in container: ccc-test')
  })

  it('SSH: the docker pill composes with the persistence pill (both shown)', () => {
    render(makeSession({ provider: 'claude', sessionType: 'ssh', sshTmuxPersistent: true, sshConfig: { host: 'h', port: 22, username: 'u', remotePath: '~', dockerContainer: 'ccc-test' } as any }))
    expect(container.querySelector('[data-testid="ssh-docker-pill"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="ssh-persistent-pill"]')).not.toBeNull()
  })

  it('SSH: no docker pill when the session is not a container', () => {
    render(makeSession({ provider: 'claude', sessionType: 'ssh', sshConfig: { host: 'h', port: 22, username: 'u', remotePath: '~' } as any }))
    expect(container.querySelector('[data-testid="ssh-docker-pill"]')).toBeNull()
  })
})

describe('the slim Ask header (#465)', () => {
  // AskHeaderLead renders the running app version; vitest has no vite define.
  beforeEach(() => { (globalThis as any).__APP_VERSION__ = '0.0.0-test' })

  const askSession = (over: Partial<Session> = {}) =>
    makeSession({ id: 'ask', kind: 'ask', label: 'Ask Conductor', configId: undefined, ...over })

  it('keeps ONLY the account pill: no claude.ai / Claude Code / GitHub pills', () => {
    useAccountProfilesStore.setState({ profiles: [{ id: 'profile-a', name: 'Work', accountEmail: 'me@work.co' } as any] })
    render(askSession({ profileId: 'profile-a', provider: 'claude', sessionType: 'local' }))
    expect(container.querySelector('[data-testid="session-pill-account"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="session-pill-claudecode"]')).toBeNull()
    expect(container.querySelector('[data-testid="session-pill-claudeai"]')).toBeNull()
    expect(container.querySelector('[data-testid="session-pill-github"]')).toBeNull()
    expect(container.textContent).not.toContain('claude.ai')
    expect(container.textContent).not.toContain('Claude Code')
    useAccountProfilesStore.setState({ profiles: [] })
  })

  it('skips the auth-status fetch entirely (no pills to feed)', () => {
    useAccountProfilesStore.setState({ profiles: [{ id: 'profile-a', name: 'Work', accountEmail: 'me@work.co' } as any] })
    render(askSession({ profileId: 'profile-a', provider: 'claude', sessionType: 'local' }))
    expect(window.electronAPI.accountWeb.status).not.toHaveBeenCalled()
    useAccountProfilesStore.setState({ profiles: [] })
  })

  it('still wears the Ask band with its history affordance', () => {
    render(askSession())
    expect(container.querySelector('[data-ux-id="ask-band"]')).not.toBeNull()
    expect(container.querySelector('[data-ux-id="ask-band-history"]')).not.toBeNull()
  })
})
