// src/renderer/components/AccountsPanel.tsx
// Shared "Accounts" panel rendered inside Settings when multipleAccountsEnabled is on.
// Shows the Default account row (alias-only rename, no delete) + one row per managed
// profile (IPC rename + delete) + an "Add another account" affordance.
import React, { useState, useEffect, useRef } from 'react'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { useSettingsStore } from '../stores/settingsStore'
import { canonicaliseEmail, middleTruncateEmail } from '../../shared/account-chip-color'
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

/** Editable name field with blur/Enter commit. Shared by Default and profile rows. */
function NameInput({
  initialValue,
  placeholder,
  onCommit,
}: {
  initialValue: string
  placeholder: string
  onCommit: (value: string) => void | Promise<void>
}) {
  const [value, setValue] = useState(initialValue)
  // Last value we actually committed, so an unchanged blur/Enter is a no-op
  // (mirrors AccountNameRow in SettingsPage; avoids a superfluous rename IPC /
  // alias write every time the field loses focus).
  const lastCommitted = useRef(initialValue)

  // Sync if the source changes externally (e.g. another surface renamed the profile).
  useEffect(() => {
    setValue(initialValue)
    lastCommitted.current = initialValue
  }, [initialValue])

  const commit = () => {
    if (value.trim() === lastCommitted.current.trim()) return
    lastCommitted.current = value
    onCommit(value)
  }

  return (
    <input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ;(e.currentTarget as HTMLInputElement).blur()
        }
      }}
      placeholder={placeholder}
      className="bg-crust/60 border border-surface0/80 rounded-lg px-3 py-1.5 text-sm text-text w-44 shrink-0 focus:outline-none focus:border-blue/50 placeholder:text-overlay0 transition-colors"
    />
  )
}

/** The always-present Default (real ~/.claude) row. Rename writes into accountAliases. */
function DefaultAccountRow({ email }: { email: string | null }) {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const theme = useResolvedTheme()

  const currentAlias = email
    ? (settings.accountAliases?.[canonicaliseEmail(email)] ?? '')
    : ''

  const commitAlias = async (raw: string) => {
    if (!email) return
    const name = raw.trim()
    const key = canonicaliseEmail(email)
    const existing = settings.accountAliases ?? {}
    if (name) {
      await updateSettings({ accountAliases: { ...existing, [key]: name } })
    } else {
      const next = { ...existing }
      delete next[key]
      await updateSettings({ accountAliases: next })
    }
  }

  // Neutral dot for the default account (no profile colour key available).
  const dot = resolveIdentityColor('mauve', theme)

  return (
    <div
      className="flex items-center gap-3 py-2 px-1 rounded-lg"
      data-testid="default-account-row"
    >
      {/* Colour dot */}
      <span
        className="w-2 h-2 rounded-full shrink-0"
        style={{ backgroundColor: dot }}
        aria-hidden
      />
      {/* Label + email */}
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
      {/* Alias rename input - no delete button for Default */}
      <NameInput
        initialValue={currentAlias}
        placeholder={email ? middleTruncateEmail(email, 20) : 'Friendly name'}
        onCommit={commitAlias}
      />
    </div>
  )
}

/** A row for a managed profile. Rename via IPC; deletable. */
function ProfileRow({ profile }: { profile: AccountProfile }) {
  const theme = useResolvedTheme()

  const commitName = async (raw: string) => {
    const name = raw.trim()
    await window.electronAPI.accountProfiles.rename(profile.id, name)
    await useAccountProfilesStore.getState().hydrate()
  }

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
      {/* Colour dot */}
      <span
        className="w-2 h-2 rounded-full shrink-0"
        style={{ backgroundColor: dot }}
        aria-hidden
      />
      {/* Email / status */}
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
      {/* Profile rename input */}
      <NameInput
        initialValue={profile.name}
        placeholder="Friendly name"
        onCommit={commitName}
      />
      {/* Delete button */}
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
        Memory, settings and history stay shared.
      </p>
    </Section>
  )
}
