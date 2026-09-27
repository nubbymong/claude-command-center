// @vitest-environment jsdom
/**
 * P3.2 of the 2.1.1 completion plan: the pure pieces behind the Accounts
 * rows (design 5.1 to 5.3).
 *
 * Verifies:
 *   - "N running" on a Claude row: live, local Claude sessions on the
 *     profile (a session naming none runs on the primary); never a plain
 *     shell, an ended or a never-started one, or another provider's;
 *   - a refusal's session ids map to this window's open sessions only;
 *   - "Archived (N)" and Restore: archived accounts per provider, and Restore
 *     never offered on a record mirrored from the provider's own list;
 *   - linking: the linked accounts (live, same identity) and the candidates
 *     (live, vouched-for, another identity; none for an unverified sign-in);
 *   - Go to: selects an open session and shows the sessions view; a session
 *     no longer open, or a malformed event, does nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AccountsSnapshot, AccountView } from '../../../src/shared/providers'
import {
  claudeSessionsOnProfile, blockerSessions, sessionTitle, selectArchivedAccounts, canOfferRestore, linkedAccounts, linkCandidates,
  linkedAccountLabel, canLinkIdentity,
} from '../../../src/renderer/stores/providerAccountsStore'
import { useSessionStore } from '../../../src/renderer/stores/sessionStore'
import { goToSession, listenGoToSession, GO_TO_SESSION_EVENT } from '../../../src/renderer/lib/goToSession'

function account(over: Partial<AccountView> & Pick<AccountView, 'id' | 'providerId' | 'identityId'>): AccountView {
  return {
    lifecycle: 'active', isProviderDefault: false, isReviewerDefault: false, authMethod: 'browser',
    lastKnownAuthState: 'signed-in', operationalState: 'ready', identityAssurance: 'user-asserted', realmLifecycle: 'active',
    external: false, unverified: false, legacyLinked: false, runningSessions: 0, runningReviews: 0, consumers: 0,
    ...over,
  }
}
function snapshot(accounts: AccountView[]): AccountsSnapshot {
  return {
    revision: 1, registry: { mode: 'ready' }, providers: [], groups: [], pendingSetups: [], externalDefaults: [], conflicts: [], reviewerNotices: [],
    identities: [{ id: 'id-a', friendlyName: 'A', colourKey: 'teal' }, { id: 'id-b', friendlyName: 'B', colourKey: 'pink' }],
    accounts,
  }
}

describe('Claude sessions on a profile ("N running")', () => {
  const s = (over: Record<string, unknown>) => ({ id: 'x', label: 'x', sessionType: 'local', provider: 'claude', ...over }) as never
  it('counts live local Claude sessions on the profile; one naming no profile runs on the primary', () => {
    const sessions = [
      s({ id: '1', profileId: 'p-work' }),
      s({ id: '2', profileId: 'p-work', provider: undefined }),
      s({ id: '3' }),
      s({ id: '4', profileId: 'p-work', shellOnly: true }),
      s({ id: '5', profileId: 'p-work', ptyExited: true }),
      s({ id: '6', profileId: 'p-work', neverStarted: true }),
      s({ id: '7', profileId: 'p-work', provider: 'codex' }),
      s({ id: '8', profileId: 'p-work', sessionType: 'ssh' }),
      s({ id: '9', profileId: 'p-home' }),
    ]
    expect(claudeSessionsOnProfile(sessions, 'p-work', 'p-main').map((x) => x.id)).toEqual(['1', '2'])
    expect(claudeSessionsOnProfile(sessions, 'p-main', 'p-main').map((x) => x.id)).toEqual(['3'])
    expect(claudeSessionsOnProfile(sessions, 'p-home', 'p-main').map((x) => x.id)).toEqual(['9'])
  })

  it('a refusal\'s ids name only sessions open here, in this window\'s order; the title is the work name', () => {
    const sessions = [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'b', customName: '  Beta  ' }, { id: 'c', label: 'Gamma' }]
    expect(blockerSessions(sessions, ['c', 'zz', 'a']).map((x) => x.id)).toEqual(['a', 'c'])
    expect(blockerSessions(sessions, undefined)).toEqual([])
    expect(sessionTitle(sessions[1])).toBe('Beta')
    expect(sessionTitle(sessions[0])).toBe('Alpha')
  })
})

describe('Archived (N) and Restore', () => {
  it('lists a provider\'s archived accounts; Restore is never offered on a mirrored record', () => {
    const gone = account({ id: 'g', providerId: 'codex', identityId: 'id-a', lifecycle: 'archived' })
    const live = account({ id: 'l', providerId: 'codex', identityId: 'id-a' })
    const mirrored = account({ id: 'm', providerId: 'claude', identityId: 'id-b', lifecycle: 'archived', legacyLinked: true })
    const snap = snapshot([gone, live, mirrored])
    expect(selectArchivedAccounts(snap, 'codex').map((a) => a.id)).toEqual(['g'])
    expect(canOfferRestore(gone)).toBe(true)
    expect(canOfferRestore(live)).toBe(false)
    expect(canOfferRestore(mirrored)).toBe(false)
  })
})

describe('linking', () => {
  const work = account({ id: 'w', providerId: 'codex', identityId: 'id-a' })
  const claudeWork = account({ id: 'cw', providerId: 'claude', identityId: 'id-a', providerLabel: 'work@example.com' })
  const archivedTwin = account({ id: 'at', providerId: 'codex', identityId: 'id-a', lifecycle: 'archived' })
  const other = account({ id: 'o', providerId: 'claude', identityId: 'id-b' })
  const ext = account({ id: 'x', providerId: 'codex', identityId: 'id-x', external: true, unverified: true })
  const unv = account({ id: 'u', providerId: 'codex', identityId: 'id-u', unverified: true })
  const snap = snapshot([work, claudeWork, archivedTwin, other, ext, unv])

  it('the linked accounts are the live ones on the same identity', () => {
    expect(linkedAccounts(snap, work).map((a) => a.id)).toEqual(['cw'])
    expect(linkedAccountLabel(snap, claudeWork)).toBe('work@example.com')
    expect(linkedAccountLabel(snap, work)).toBe('A')
  })

  it('candidates are live, vouched-for accounts on another identity; an unverified sign-in links nothing', () => {
    expect(linkCandidates(snap, work).map((a) => a.id)).toEqual(['o'])
    expect(linkCandidates(snap, ext)).toEqual([])
    expect(linkCandidates(snap, unv)).toEqual([])
    expect(canLinkIdentity(ext)).toBe(false)
    expect(canLinkIdentity(work)).toBe(true)
  })
})

describe('Go to <session>', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [{ id: 's-1' }, { id: 's-2' }] as never, activeSessionId: 's-2' })
  })

  it('selects an open session and shows the sessions view', () => {
    const show = vi.fn()
    const off = listenGoToSession(show)
    goToSession('s-1')
    expect(useSessionStore.getState().activeSessionId).toBe('s-1')
    expect(show).toHaveBeenCalledTimes(1)
    off()
    goToSession('s-2')
    expect(useSessionStore.getState().activeSessionId).toBe('s-1')
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('a session no longer open, or an event without a string id, does nothing', () => {
    const show = vi.fn()
    const off = listenGoToSession(show)
    goToSession('s-gone')
    window.dispatchEvent(new CustomEvent(GO_TO_SESSION_EVENT, { detail: { sessionId: 7 } }))
    window.dispatchEvent(new CustomEvent(GO_TO_SESSION_EVENT))
    expect(useSessionStore.getState().activeSessionId).toBe('s-2')
    expect(show).not.toHaveBeenCalled()
    off()
  })
})
