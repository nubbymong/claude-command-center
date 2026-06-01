// src/renderer/components/AccountsPanel.tsx
// Shared "Accounts" panel rendered inside Settings when multipleAccountsEnabled is on.
// Each account is identified by its email. The Default row (real ~/.claude) is
// never deletable; each managed profile row has a delete button. An "Add
// another account" affordance starts the login flow. No friendly-name editing --
// accounts are shown by email so the panel is unambiguous.
import React, { useEffect } from 'react'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { middleTruncateEmail } from '../../shared/account-chip-color'
import { useResolvedTheme } from '../hooks/useThemeController'
import { resolveIdentityColor } from '../../shared/identity-colors'
import type { AccountProfile } from '../../shared/account-types'
import { Section } from './SettingsPage'

// ---- props ------------------------------------------------------------------

export interface AccountsPanelProps {
  defaultEmail: string | null
  onAdd: () => void | Promise<void>
}

// ---- sub-components ---------------------------------------------------------

/** The always-present Default (real ~/.claude) row. Email-only, never deletable. */
function DefaultAccountRow({ email }: { email: string | null }) {
  const theme = useResolvedTheme()
  // Neutral dot for the default account (no profile colour key available).
  const dot = resolveIdentityColor('mauve', theme)

  return (
    <div
      className="flex items-center gap-3 py-2 px-1 rounded-lg"
      data-testid="default-account-row"
    >
      <span
        className="w-2 h-2 rounded-full shrink-0"
        style={{ backgroundColor: dot }}
        aria-hidden
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-subtext0 uppercase tracking-wide">Default</span>
          <span className="text-[10px] text-overlay0 border border-overlay0/30 rounded px-1">current login</span>
        </div>
        <span
          className="text-sm font-mono truncate block mt-0.5"
          style={{ color: 'var(--text-secondary)' }}
          title={email ?? undefined}
        >
          {email ? middleTruncateEmail(email) : <span className="text-overlay0 italic">not signed in</span>}
        </span>
      </div>
    </div>
  )
}

/** A row for a managed profile. Email-only; deletable. */
function ProfileRow({ profile }: { profile: AccountProfile }) {
  const theme = useResolvedTheme()

  const handleDelete = async () => {
    const confirmed = window.confirm(
      'Remove this account from CCC? Your Claude login is not affected.'
    )
    if (!confirmed) return
    await window.electronAPI.accountProfiles.delete(profile.id)
    await useAccountProfilesStore.getState().hydrate()
  }

  // Colour dot: use the profile's colour key if set, else fall back to 'mauve'.
  const dot = resolveIdentityColor(profile.colourKey ?? 'mauve', theme)
  const hasEmail = !!profile.accountEmail

  return (
    <div
      className="flex items-center gap-3 py-2 px-1 rounded-lg"
      data-testid={`profile-row-${profile.id}`}
    >
      <span
        className="w-2 h-2 rounded-full shrink-0"
        style={{ backgroundColor: dot }}
        aria-hidden
      />
      <div className="flex-1 min-w-0">
        <span
          className="text-sm font-mono truncate block"
          style={{ color: hasEmail ? 'var(--text-secondary)' : undefined }}
          title={hasEmail ? profile.accountEmail : undefined}
        >
          {hasEmail ? (
            middleTruncateEmail(profile.accountEmail)
          ) : (
            <span className="text-overlay0 italic">setup incomplete</span>
          )}
        </span>
      </div>
      <button
        onClick={handleDelete}
        title="Remove this account from CCC"
        data-testid={`delete-profile-${profile.id}`}
        className="ml-1 p-1 rounded text-overlay1 hover:text-red hover:bg-red/10 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-red/50 shrink-0"
        aria-label="Remove account"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M3 4h10M5 4V2.5h6V4M6.5 7v5M9.5 7v5M4 4l.75 8.5a1 1 0 001 .9h4.5a1 1 0 001-.9L12 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  )
}

// ---- main component ---------------------------------------------------------

export default function AccountsPanel({ defaultEmail, onAdd }: AccountsPanelProps) {
  const profiles = useAccountProfilesStore((s) => s.profiles)

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
      title="Accounts"
      icon={
        <>
          <circle cx="8" cy="5.5" r="2.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
          <path d="M3.5 13c0-2.2 2-3.5 4.5-3.5s4.5 1.3 4.5 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none" />
        </>
      }
    >
      <div className="space-y-1 divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
        {/* Default row - always shown, never deletable */}
        <DefaultAccountRow email={defaultEmail} />

        {/* One row per managed profile */}
        {profiles.map((profile) => (
          <div key={profile.id} className="pt-1">
            <ProfileRow profile={profile} />
          </div>
        ))}
      </div>

      {/* Add another account */}
      <button
        onClick={onAdd}
        data-testid="add-account-btn"
        className="mt-3 w-full flex items-center justify-center gap-2 rounded-lg border border-dashed border-surface1 hover:border-blue/50 text-overlay1 hover:text-blue py-2 px-4 text-sm transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-blue/50"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        Add another account
      </button>

      {/* Informational note - no em dashes */}
      <p className="text-[11px] text-overlay0 leading-relaxed mt-2">
        Signing in or out of an added account never touches the others or your default.
        Memory, settings and history stay shared. You pick which account a session runs
        under when it starts.
      </p>
    </Section>
  )
}
