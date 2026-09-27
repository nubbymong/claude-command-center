// src/renderer/components/AccountsPanel.tsx
// Shared "Accounts" panel rendered inside Settings when multi-account is on.
// Every account is a profile; the primary profile (captured global) is shown
// as "Primary" and cannot be removed. All other profiles can be made
// inactive and removed. P3.2: each profile is the shared AccountRow the
// managed providers use (design 5.3, canvas "Accounts: identities across
// providers" v1, option B): its chip opens the identity editor, which now
// holds the name and colour fields this row used to show inline; "N
// running" counts its Claude sessions; a removal refused while sessions run
// on it names them with Go to. With Claude Code off the accounts are listed
// but not managed, as every provider's are.
import React, { useState, useEffect, useRef } from 'react'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useSessionStore } from '../stores/sessionStore'
import { middleTruncateEmail, canonicaliseEmail, resolveAccountColourKey } from '../../shared/account-chip-color'
import { useResolvedTheme } from '../hooks/useThemeController'
import { resolveIdentityColor } from '../../shared/identity-colors'
import type { IdentityColorKey } from '../../shared/identity-colors'
import { isAccountActive, type AccountProfile } from '../../shared/account-types'
import { Section } from './SettingsPage'
import { AccountWebSession } from './settings/AccountWebSession'
import { AccountIsolationNotice } from './settings/AccountIsolationNotice'
import {
  useProviderAccountsStore, providerAccountActions, accountForLegacyId, canOfferMakeReviewer, showsReviewerBadge, accountFailureText,
  accountDisplayName, identityOf, linkedAccounts, linkedAccountLabel, providerView, claudeSessionsOnProfile, sessionTitle,
  blockerSessions, unnamedHolders,
} from '../stores/providerAccountsStore'
import { claudeCodeOn } from '../onboarding/hello-codex'
import { ProviderMark } from './sidebar/Badges'
import { Pill, MutedLine, ErrorLine, ReviewerLineBlock, RunningPill } from './settings/accounts/accounts-ui'
import { AccountRow, AccountChip, LinkedLine, BlockerLine } from './settings/accounts/AccountRow'
import { IdentityEditor, type LegacyIdentityEdit } from './settings/accounts/IdentityEditor'
import { RowMenu, type MenuItem } from './ui/RowMenu'

// ---- props ------------------------------------------------------------------

export interface AccountsPanelProps {
  onAdd: () => void | Promise<void>
}

// ---- sub-components ---------------------------------------------------------

/** One row per profile. The primary shows "Primary" and cannot be removed. */
function ProfileRow({ profile, primaryId, claudeOn }: { profile: AccountProfile; primaryId: string | undefined; claudeOn: boolean }) {
  const theme = useResolvedTheme()
  const accountColourOverrides = useSettingsStore((s) => s.settings.accountColourOverrides)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const sessions = useSessionStore((s) => s.sessions)
  const [error, setError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [blocker, setBlocker] = useState<{ verb: string; sessions: { id: string; title: string }[]; more: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const chipRef = useRef<HTMLButtonElement>(null)

  // WP2: this profile's account in the provider registry (it mirrors the
  // profile id), for its reviewer state, identity and links. Absent until
  // the registry lists it.
  const snapshot = useProviderAccountsStore((s) => s.snapshot)
  const registryAccount = accountForLegacyId(snapshot, 'claude', profile.id)
  const identity = registryAccount ? identityOf(snapshot, registryAccount) : undefined
  const refusal = registryAccount?.reviewRefusal
  const refusalText = !refusal ? null
    : refusal.reason === 'platform'
      ? (window.electronPlatform === 'darwin' ? "Can't run Claude reviews on macOS" : refusal.message)
      : "Can't check whether this account can run reviews right now"

  const active = isAccountActive(profile)
  const hasEmail = !!profile.accountEmail
  const running = claudeSessionsOnProfile(sessions, profile.id, primaryId)

  const act = async (op: () => Promise<string | null>) => {
    setBusy(true)
    setError(null)
    setBlocker(null)
    try {
      const failed = await op()
      if (failed) setError(failed)
    } catch {
      setError('That did not work; try again.')
    } finally {
      setBusy(false)
    }
  }

  /** A refusal for "in use" names the sessions main found on the profile
   *  that this window has open, each with Go to, and "and N more" for the
   *  rest; with none of them open here, the row keeps main's own words. */
  const blockerFrom = (verb: string, res: { sessions?: string[]; unnamed?: number }) => {
    const named = blockerSessions(useSessionStore.getState().sessions, res.sessions)
    if (!named.length) return null
    return { verb, sessions: named.map((s) => ({ id: s.id, title: sessionTitle(s) })), more: unnamedHolders(res.sessions, named, res.unnamed) }
  }

  const makeReviewer = () => act(async () => {
    if (!registryAccount) return null
    const r = await providerAccountActions.setReviewerDefault({ providerId: 'claude', accountId: registryAccount.id })
    return r.ok ? null : accountFailureText(r)
  })

  // Active/inactive: an inactive account stays listed here but cannot be chosen
  // when switching a session's account. The primary account is always active.
  const setActive = (next: boolean) => act(async () => {
    const res = await window.electronAPI.accountProfiles.setActive(profile.id, next)
    // Nothing changed on a refusal: the row stays as it is, with the reason.
    if (res && res.ok === false) {
      const b = res.code === 'in-use' ? blockerFrom('made inactive', res) : null
      if (b) { setBlocker(b); return null }
      return res.error || 'That did not work.'
    }
    await useAccountProfilesStore.getState().hydrate()
    return null
  })

  const handleDelete = async () => {
    const confirmed = window.confirm(
      'Remove this account from AI Code Conductor? Your Claude login is not affected.'
    )
    if (!confirmed) return
    setDeleteError(null)
    setBlocker(null)
    // Surface a failed delete instead of swallowing it: the main process refuses
    // to delete a profile that a live session is running under, and a teardown can
    // throw on a Windows file lock. Both come back as { ok:false, error }. Refused
    // while this window's sessions run on it, the row names them (design 5.3).
    try {
      const res = await window.electronAPI.accountProfiles.delete(profile.id)
      if (!res?.ok) {
        const b = res?.code === 'in-use' || res?.code === 'in-use-cleared' ? blockerFrom('removed', res) : null
        if (b) setBlocker(b)
        // Main's words stay unless the blocker says the same thing: after its
        // claude.ai sign-in was cleared, they say what did happen.
        if (!b || res?.code === 'in-use-cleared') setDeleteError(res?.error || 'Could not remove this account. Please try again.')
        return
      }
    } catch {
      setDeleteError('Could not remove this account. Please try again.')
      return
    }
    await useAccountProfilesStore.getState().hydrate()
  }

  // The legacy colour: the email-keyed override wins over the profile's key.
  const legacyColourKey = resolveAccountColourKey(profile.accountEmail, accountColourOverrides, profile.colourKey)
  const colourKey = (identity?.colourKey as IdentityColorKey | undefined) ?? legacyColourKey
  const tint = resolveIdentityColor(colourKey, theme)
  const email = hasEmail ? profile.accountEmail : ''
  const name = registryAccount ? accountDisplayName(snapshot, registryAccount) : (profile.name?.trim() || (hasEmail ? middleTruncateEmail(email) : 'Account'))

  // The account list not available: the name and colour are edited the way
  // this row always did (profiles.json and the email-keyed colour).
  const legacy: LegacyIdentityEdit = {
    name: profile.name ?? '',
    colourKey: legacyColourKey,
    canColour: hasEmail,
    rename: async (next) => {
      await window.electronAPI.accountProfiles.rename(profile.id, next)
      await useAccountProfilesStore.getState().hydrate()
      return null
    },
    recolour: async (key) => {
      if (!profile.accountEmail) return null
      await updateSettings({ accountColourOverrides: { ...(accountColourOverrides ?? {}), [canonicaliseEmail(profile.accountEmail)]: key } })
      return null
    },
  }

  const items: MenuItem[] = []
  if (claudeOn) {
    if (registryAccount && canOfferMakeReviewer(snapshot, registryAccount)) {
      items.push({ key: 'make-reviewer', label: 'Make reviewer', onSelect: () => { void makeReviewer() } })
    }
    if (!profile.isPrimary) {
      items.push(active
        ? { key: 'make-inactive', label: 'Make inactive', onSelect: () => { void setActive(false) }, separated: items.length > 0 }
        : { key: 'make-active', label: 'Make active', onSelect: () => { void setActive(true) }, separated: items.length > 0 })
      items.push({ key: 'remove', label: 'Remove', onSelect: () => { void handleDelete() } })
    }
  }

  const links = registryAccount ? linkedAccounts(snapshot, registryAccount) : []
  return (
    <AccountRow
      testId={`profile-row-${profile.id}`}
      chip={(
        <AccountChip
          letter={(profile.name?.trim() || email || '?').charAt(0).toUpperCase()}
          tint={tint}
          onOpen={claudeOn ? () => setEditing((e) => !e) : undefined}
          open={editing}
          label={`Edit ${name}: name, colour, group and linked accounts`}
          testId={`profile-chip-${profile.id}`}
          chipRef={chipRef}
        />
      )}
      name={name}
      nameMuted={!active}
      nameTestId={`profile-name-${profile.id}`}
      secondary={hasEmail
        ? <span className="font-mono text-[12px] truncate max-w-full" style={{ color: 'var(--text-secondary)' }} title={email}>{middleTruncateEmail(email)}</span>
        : <span className="text-[12px] italic" style={{ color: 'var(--text-muted)' }}>setup incomplete</span>}
      linked={links.map((a) => (
        <LinkedLine
          key={a.id}
          providerId={a.providerId}
          providerName={providerView(snapshot, a.providerId)?.displayName ?? a.providerId}
          label={linkedAccountLabel(snapshot, a)}
          testId={`profile-linked-${profile.id}-${a.id}`}
        />
      ))}
      planCell={profile.isPrimary ? <MutedLine testId={`primary-badge-${profile.id}`}>Primary</MutedLine> : null}
      badges={(
        <>
          {registryAccount && showsReviewerBadge(registryAccount) && (
            <Pill tone="reviewer" testId={`claude-reviewer-badge-${profile.id}`}>Reviewer</Pill>
          )}
          {!active && <Pill tone="muted" testId={`inactive-badge-${profile.id}`}>Inactive</Pill>}
        </>
      )}
      stateCell={<RunningPill count={running.length} testId={`profile-running-${profile.id}`} />}
      menu={(
        <RowMenu
          items={items}
          label={`Actions for ${name}`}
          disabled={busy}
          testId={`profile-menu-btn-${profile.id}`}
          itemTestId={(key) => `profile-menu-${key}-${profile.id}`}
        />
      )}
    >
      {refusalText && claudeOn && <MutedLine className="mt-1" testId={`claude-review-refusal-${profile.id}`}>{refusalText}</MutedLine>}
      {error && <ErrorLine testId={`profile-error-${profile.id}`}>{error}</ErrorLine>}
      {/* #216: both halves of this account's authentication. Shown per account
          because the claude.ai web session is per account by construction —
          one partition each — and because the code-session token and the web
          session fail in ways that look nothing alike. Not while Claude Code
          is off: its accounts are listed, not managed. */}
      {claudeOn && (
        <div className="mt-2">
          <AccountWebSession profileId={profile.id} accountName={profile.name} />
        </div>
      )}
      {/* Layer 4 of the account-isolation hardening: whatever the
          managed-launch preflight could not confirm FOR THIS ACCOUNT. Per
          row, not once for the panel: a single merged notice folded every
          account's findings into one list and deduped by finding id, so a
          second account's occurrence was invisible rather than merely
          unattributed, and the detail text carried that account's stripped
          settings keys across the boundary this panel exists to defend
          (adversarial review, MAJOR 5). Renders nothing when there is nothing
          to say, so a healthy install pays no space for it. */}
      {claudeOn && <AccountIsolationNotice profileId={profile.id} />}
      {blocker && <BlockerLine name={name} verb={blocker.verb} sessions={blocker.sessions} more={blocker.more} testId={`profile-blocker-${profile.id}`} />}
      {deleteError && (
        <p
          className="text-[11px] text-red mt-1.5"
          role="alert"
          data-testid={`delete-error-${profile.id}`}
        >
          {deleteError}
        </p>
      )}
      {editing && claudeOn && (
        <IdentityEditor
          anchor={chipRef}
          account={registryAccount ?? null}
          snapshot={snapshot}
          legacy={registryAccount && identity ? undefined : legacy}
          onClose={() => setEditing(false)}
          testId={`identity-editor-${profile.id}`}
        />
      )}
    </AccountRow>
  )
}

// ---- main component ---------------------------------------------------------

export default function AccountsPanel({ onAdd }: AccountsPanelProps) {
  const profiles = useAccountProfilesStore((s) => s.profiles)
  // Claude Code on (claudeCodeOn: the saved setting says so, absent meaning
  // on, and main has not switched it off). While it is off no Claude session
  // starts, so an account added then could not be used: the card lists its
  // accounts without managing them and says how to turn it on instead, as
  // the other providers' cards do (ManagedAccountsSection).
  const claudeEnabled = useSettingsStore((s) => s.settings.claudeEnabled)
  const snapshot = useProviderAccountsStore((s) => s.snapshot)
  const claudeOn = claudeCodeOn({ claudeEnabled }, snapshot)
  const primaryId = profiles.find((p) => p.isPrimary)?.id

  // On open, reconcile any "setup incomplete" account: the user's /login may have
  // finished after the live add-account poll's window, so re-read each empty
  // profile's own .claude.json (refreshIdentity upserts the email if present).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const incomplete = useAccountProfilesStore.getState().profiles.filter((p) => !p.accountEmail)
      if (incomplete.length === 0) return
      let found = false
      for (const p of incomplete) {
        try {
          const res = await window.electronAPI.accountProfiles?.refreshIdentity?.(p.id)
          if (res && res.email) found = true
        } catch { /* ignore; best-effort reconcile */ }
      }
      if (found && !cancelled) await useAccountProfilesStore.getState().hydrate()
    })()
    return () => { cancelled = true }
  }, [])

  return (
    <Section
      title="Claude"
      mark={<ProviderMark providerId="claude" size={16} />}
      testId="provider-accounts-claude"
    >
      {/* WP2: which Claude account code reviews (asked for from the other
          provider's sessions) use. Renders nothing until the registry says
          Claude reviews here. */}
      <ReviewerLineBlock providerId="claude" />
      {!claudeOn && (
        <MutedLine testId="provider-off-note-claude">Turn Claude Code on to manage its accounts.</MutedLine>
      )}
      <div>
        {profiles.map((profile) => (
          <ProfileRow key={profile.id} profile={profile} primaryId={primaryId} claudeOn={claudeOn} />
        ))}
      </div>

      {/* Add an account. Windows-only: on macOS Claude Code keeps its
          OAuth token in the login Keychain, which per-profile HOME redirection
          cannot isolate, so added accounts would silently share one login
          (Mac readiness review 2026-07-02). "Another" only when there is one
          already. The notes are --text-muted: --color-overlay0 measured 2.1:1
          (dark) and 3.2:1 (light) on this card (VM audit 2026-09-25). */}
      {claudeOn && (window.electronPlatform === 'darwin' ? (
        <p className="mt-3 text-[11px] leading-relaxed rounded-lg border border-dashed border-surface1 py-2 px-4" style={{ color: 'var(--text-muted)' }} data-testid="accounts-mac-note">
          Multiple accounts are not available on macOS yet: Claude Code stores its sign-in
          token in the macOS Keychain, which is shared across the whole app, so added
          accounts could not be kept separate. Your single account works exactly as normal.
        </p>
      ) : (
        <button
          onClick={onAdd}
          data-testid="add-account-btn"
          className="mt-3 w-full flex items-center justify-center gap-2 rounded-lg border border-dashed border-surface1 hover:border-blue/50 text-overlay1 hover:text-blue py-2 px-4 text-sm transition-colors focus-ring-strong"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          {profiles.length === 0 ? 'Add an account' : 'Add another account'}
        </button>
      ))}


      {/* Informational note - no em dashes */}
      {claudeOn && (
        <p className="text-[11px] leading-relaxed mt-2" style={{ color: 'var(--text-muted)' }} data-testid="accounts-claude-note">
          The email is the account; the name is just a friendly label for you. Signing in or
          out of an added account never touches the others or your default, and memory,
          settings and history stay shared. You pick which account a session runs under when
          it starts.
        </p>
      )}
    </Section>
  )
}
