// @vitest-environment jsdom
/**
 * FIX (owner request, 2026-09-01): while an SSH Claude session's identity is
 * still in flight -- no reported remote email AND no mapped local profile yet --
 * the top bar showed nothing where the account · claude.ai · Claude Code pills
 * land. SessionAuthPills now renders a loading shimmer there (SshAuthPending),
 * resolved the instant identity arrives and self-limiting after a bound so it
 * never shimmers forever ("a shimmer that never resolves is worse than blank").
 *
 * SessionAuthPills is not exported, so these drive the whole SessionHeader.
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

const SSH_CFG = { host: 'h', port: 22, username: 'u', remotePath: '~' } as any

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: 's1', label: 'web', workingDirectory: '/home/me/web', model: 'sonnet',
    color: '#ff0000', status: 'idle', createdAt: 0, sessionType: 'local', configId: 'cfg-1', ...over,
  } as Session
}
/** A standard SSH Claude session with NO identity known yet (no live tick, no
 *  setup-sentinel, no mapped profile) -- the pending case. */
function sshNoIdentity(over: Partial<Session> = {}): Session {
  return makeSession({
    provider: 'claude', sessionType: 'ssh', sshConfig: SSH_CFG,
    accountEmail: undefined, sshRemoteAccount: undefined, profileId: undefined, ...over,
  })
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  _resetAccountAuthForTest()
  useAccountProfilesStore.setState({ profiles: [] })
  ;(globalThis as any).window.electronAPI = {
    accountWeb: { status: vi.fn(async () => ({ ok: true, cli: { authenticated: false }, web: { status: 'none' } })) },
  }
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  useAccountProfilesStore.setState({ profiles: [] })
  vi.useRealTimers()
})
const render = (s: Session) => act(() => { root.render(<SessionHeader session={s} />) })
const q = (sel: string) => container.querySelector(sel)

describe('SSH account pending shimmer (SshAuthPending)', () => {
  it('renders the shimmer -- account · claude.ai · Claude Code skeletons -- for an SSH Claude session with no identity', () => {
    render(sshNoIdentity())
    const pending = q('[data-testid="session-auth-pending"]')
    expect(pending).not.toBeNull()
    expect(pending?.getAttribute('aria-label')).toBe('Loading account')
    // Three skeleton pills, sized like the resolved trio.
    expect(container.querySelectorAll('[data-testid="session-auth-skeleton"]').length).toBe(3)
    // The shimmer track the bottom bar uses, so the two read as one signal.
    expect(container.querySelector('.statusline-pending-track')).not.toBeNull()
    // ...and the REAL pills are (correctly) still absent.
    expect(q('[data-testid="session-pill-account"]')).toBeNull()
    expect(q('[data-testid="session-pill-claudecode"]')).toBeNull()
    expect(q('[data-testid="session-pill-claudeai"]')).toBeNull()
  })

  it('replaces the shimmer with the real pills the instant the account arrives, and clears its give-up timer', () => {
    vi.useFakeTimers()
    useAccountProfilesStore.setState({ profiles: [{ id: 'profile-ssh', name: 'Work', accountEmail: 'remote@x.com' } as any] })
    useAccountAuthStore.setState({ byProfile: { 'profile-ssh': { cliAuthed: true, web: 'active', loading: false, fetchedAt: 1 } } })
    // First frame: identity unknown -> shimmer (its give-up timer is now armed).
    render(sshNoIdentity())
    expect(q('[data-testid="session-auth-pending"]')).not.toBeNull()
    // The live tunnel /status delivers the account -> the parent switches branch.
    render(sshNoIdentity({ accountEmail: 'remote@x.com' }))
    expect(q('[data-testid="session-auth-pending"]')).toBeNull()
    expect(q('[data-testid="session-pill-account"]')).not.toBeNull()
    expect(q('[data-testid="session-pill-claudecode"]')).not.toBeNull()
    // The shimmer unmounted, so its give-up timer must have been cleared. React 19
    // does not warn on a setState after unmount, so assert the cleanup explicitly:
    // the shimmer's timeout is the only timer this header arms, and a leak
    // (mutation: drop the effect's clearTimeout) would leave the count above 0.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a switch to a DIFFERENT still-pending session gets its OWN give-up clock (keyed per session)', () => {
    vi.useFakeTimers()
    // Session A pending; let its 20s give-up clock run almost to the bound.
    render(sshNoIdentity({ id: 'sA' }))
    expect(q('[data-testid="session-auth-pending"]')).not.toBeNull()
    act(() => { vi.advanceTimersByTime(19_000) })
    expect(q('[data-testid="session-auth-pending"]')).not.toBeNull()
    // Switch to a DIFFERENT still-pending session B. Without key={session.id} the
    // shimmer stays mounted and B inherits A's 19s-elapsed clock; with the key it
    // remounts with a fresh clock.
    render(sshNoIdentity({ id: 'sB' }))
    // 2s later is 21s into A (past its bound) but only 2s into B -- B must still
    // shimmer. Fails without the per-session key (A's timer fires and blanks it).
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(q('[data-testid="session-auth-pending"]')).not.toBeNull()
  })

  it('gives up after the timeout and falls back to blank -- never shimmers forever', () => {
    vi.useFakeTimers()
    render(sshNoIdentity())
    expect(q('[data-testid="session-auth-pending"]')).not.toBeNull()
    // Just before the bound: still shimmering.
    act(() => { vi.advanceTimersByTime(19_000) })
    expect(q('[data-testid="session-auth-pending"]')).not.toBeNull()
    // Past the bound: gone, and (no repo slug) the cluster is blank as before.
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(q('[data-testid="session-auth-pending"]')).toBeNull()
    expect(q('[data-testid="session-pill-github"]')).toBeNull()
  })

  it('the GitHub pill rides the pending set only when a repo slug is set', () => {
    // No slug -> shimmer alone.
    render(sshNoIdentity())
    expect(q('[data-testid="session-auth-pending"]')).not.toBeNull()
    expect(q('[data-testid="session-pill-github"]')).toBeNull()
    // Slug -> shimmer AND the real GitHub pill.
    render(sshNoIdentity({ githubIntegration: { enabled: true, repoSlug: 'nubbymong/web', autoDetected: true } as any }))
    expect(q('[data-testid="session-auth-pending"]')).not.toBeNull()
    expect(q('[data-testid="session-pill-github"]')).not.toBeNull()
  })

  it('never renders the shimmer for a LOCAL Claude session (identity comes from the profile)', () => {
    render(makeSession({ provider: 'claude', sessionType: 'local', profileId: undefined }))
    expect(q('[data-testid="session-auth-pending"]')).toBeNull()
  })

  it('never renders the shimmer for a shell-only SSH session or a Codex SSH session', () => {
    render(makeSession({ provider: 'claude', sessionType: 'ssh', shellOnly: true, sshConfig: SSH_CFG }))
    expect(q('[data-testid="session-auth-pending"]')).toBeNull()
    render(makeSession({ provider: 'codex', sessionType: 'ssh', sshConfig: SSH_CFG }))
    expect(q('[data-testid="session-auth-pending"]')).toBeNull()
  })

  it('does NOT render the shimmer once a mapped local profile exists (real pills instead)', () => {
    useAccountProfilesStore.setState({ profiles: [{ id: 'profile-ssh', name: 'Work' } as any] })
    useAccountAuthStore.setState({ byProfile: { 'profile-ssh': { cliAuthed: true, web: 'active', loading: false, fetchedAt: 1 } } })
    // A launch profileId that maps (sshMappedProfileId falls back to it pre-identity).
    render(sshNoIdentity({ profileId: 'profile-ssh' }))
    expect(q('[data-testid="session-auth-pending"]')).toBeNull()
    expect(q('[data-testid="session-pill-account"]')).not.toBeNull()
  })
})
