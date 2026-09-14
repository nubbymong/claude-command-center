// src/renderer/components/AccountsPanel.tsx
// Shared "Accounts" panel rendered inside Settings when multi-account is on.
// Every account is a profile; the primary profile (captured global) is shown
// with a "primary" badge and cannot be deleted. All other profiles are
// renameable and deletable.
import React, { useState, useEffect, useRef } from 'react'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { useSettingsStore } from '../stores/settingsStore'
import { middleTruncateEmail, canonicaliseEmail, resolveAccountColourKey } from '../../shared/account-chip-color'
import { useResolvedTheme } from '../hooks/useThemeController'
import { resolveIdentityColor, IDENTITY_COLOR_KEYS } from '../../shared/identity-colors'
import type { IdentityColorKey } from '../../shared/identity-colors'
import { isAccountActive, type AccountProfile } from '../../shared/account-types'
import ToggleSwitch from './github/config/ToggleSwitch'
import { Section } from './SettingsPage'
import { AccountWebSession } from './settings/AccountWebSession'

// ---- props ------------------------------------------------------------------

export interface AccountsPanelProps {
  onAdd: () => void | Promise<void>
}

// ---- sub-components ---------------------------------------------------------

/** Labelled, obviously-editable friendly-name field. Commits on blur/Enter. */
function NameField({
  initialValue,
  onCommit,
}: {
  initialValue: string
  onCommit: (value: string) => void | Promise<void>
}) {
  const [value, setValue] = useState(initialValue)
  // Last committed value so an unchanged blur/Enter is a no-op.
  const lastCommitted = useRef(initialValue)

  // Sync if the source changes externally (e.g. another surface renamed it).
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
    <div className="flex items-center gap-2 mt-1.5">
      <span className="text-[11px] text-subtext0 w-10 shrink-0">Name</span>
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
        placeholder="Optional friendly name"
        className="flex-1 bg-crust/60 border border-surface0/80 rounded-lg px-3 py-1.5 text-sm text-text focus:outline-none focus:border-blue/50 placeholder:text-overlay0 transition-colors"
      />
    </div>
  )
}

/** Compact colour-swatch palette picker for a profile's identity colour. Only
 *  shown when the profile has a resolved accountEmail (incomplete profiles have
 *  no identity to colour yet). */
function ColourPicker({
  profile,
  currentKey,
  onPick,
}: {
  profile: AccountProfile
  currentKey: IdentityColorKey
  onPick: (key: IdentityColorKey) => void
}) {
  const theme = useResolvedTheme()
  return (
    <div className="flex items-center gap-2 mt-1.5" data-testid={`colour-picker-${profile.id}`}>
      <span className="text-[11px] text-subtext0 w-10 shrink-0">Colour</span>
      <div className="flex flex-wrap gap-1.5">
        {IDENTITY_COLOR_KEYS.map((key) => {
          const hex = resolveIdentityColor(key, theme)
          const isSelected = key === currentKey
          return (
            <button
              key={key}
              data-testid={`colour-swatch-${profile.id}-${key}`}
              title={key}
              aria-label={`Set colour to ${key}${isSelected ? ' (current)' : ''}`}
              aria-pressed={isSelected}
              onClick={() => onPick(key)}
              className="w-4 h-4 rounded-full transition-transform focus:outline-none focus-visible:ring-1 focus-visible:ring-blue/50"
              style={{
                backgroundColor: hex,
                outline: isSelected ? `2px solid ${hex}` : undefined,
                outlineOffset: isSelected ? '2px' : undefined,
                transform: isSelected ? 'scale(1.2)' : undefined,
              }}
            />
          )
        })}
      </div>
    </div>
  )
}

/** One row per profile. Primary profile shows a "primary" badge and has no delete button. */
function ProfileRow({ profile }: { profile: AccountProfile }) {
  const theme = useResolvedTheme()
  const accountColourOverrides = useSettingsStore((s) => s.settings.accountColourOverrides)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Active/inactive: an inactive account stays listed here but cannot be chosen
  // when switching a session's account. The primary account is always active.
  const active = isAccountActive(profile)
  const setActive = async (next: boolean) => {
    await window.electronAPI.accountProfiles.setActive(profile.id, next)
    await useAccountProfilesStore.getState().hydrate()
  }

  const commitName = async (raw: string) => {
    const name = raw.trim()
    await window.electronAPI.accountProfiles.rename(profile.id, name)
    await useAccountProfilesStore.getState().hydrate()
  }

  const handleDelete = async () => {
    const confirmed = window.confirm(
      'Remove this account from AI Code Conductor? Your Claude login is not affected.'
    )
    if (!confirmed) return
    setDeleteError(null)
    // Surface a failed delete instead of swallowing it: the main process refuses
    // to delete a profile that a live session is running under, and a teardown can
    // throw on a Windows file lock. Both come back as { ok:false, error }.
    try {
      const res = await window.electronAPI.accountProfiles.delete(profile.id)
      if (!res?.ok) {
        setDeleteError(res?.error || 'Could not remove this account. Please try again.')
        return
      }
    } catch {
      setDeleteError('Could not remove this account. Please try again.')
      return
    }
    await useAccountProfilesStore.getState().hydrate()
  }

  const handlePickColour = async (key: IdentityColorKey) => {
    if (!profile.accountEmail) return
    const emailKey = canonicaliseEmail(profile.accountEmail)
    const next = { ...(accountColourOverrides ?? {}), [emailKey]: key }
    await updateSettings({ accountColourOverrides: next })
  }

  // Colour dot: user override (by email) wins over the profile's stored key.
  const activeColourKey = resolveAccountColourKey(
    profile.accountEmail,
    accountColourOverrides,
    profile.colourKey,
  )
  const dot = resolveIdentityColor(activeColourKey, theme)
  const hasEmail = !!profile.accountEmail

  return (
    <div className="py-2 px-1 rounded-lg" data-testid={`profile-row-${profile.id}`}>
      <div className="flex items-center gap-3">
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: dot }}
          aria-hidden
        />
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span
            className="text-sm font-mono truncate"
            style={{ color: !active ? 'var(--color-overlay0)' : (hasEmail ? 'var(--text-secondary)' : undefined) }}
            title={hasEmail ? profile.accountEmail : undefined}
          >
            {hasEmail ? (
              middleTruncateEmail(profile.accountEmail)
            ) : (
              <span className="text-overlay0 italic">setup incomplete</span>
            )}
          </span>
          {profile.isPrimary && (
            <span className="text-[10px] text-overlay0 border border-overlay0/30 rounded px-1 shrink-0">
              primary
            </span>
          )}
          {!active && (
            <span
              className="text-[10px] text-overlay0 border border-overlay0/30 rounded px-1 shrink-0"
              data-testid={`inactive-badge-${profile.id}`}
            >
              inactive
            </span>
          )}
        </div>
        {!profile.isPrimary && (
          <ToggleSwitch
            state={active ? 'on' : 'off'}
            onToggle={() => { void setActive(!active) }}
            label={active ? 'Deactivate this account' : 'Activate this account'}
            title={active
              ? 'Active: selectable when switching a session’s account'
              : 'Inactive: still shown in the switcher, but can’t be selected'}
          />
        )}
        {!profile.isPrimary && (
          <button
            onClick={handleDelete}
            title="Remove this account from AI Code Conductor"
            data-testid={`delete-profile-${profile.id}`}
            className="ml-1 p-1 rounded text-overlay1 hover:text-red hover:bg-red/10 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-red/50 shrink-0"
            aria-label="Remove account"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path d="M3 4h10M5 4V2.5h6V4M6.5 7v5M9.5 7v5M4 4l.75 8.5a1 1 0 001 .9h4.5a1 1 0 001-.9L12 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
      <div className="ml-5">
        <NameField initialValue={profile.name} onCommit={commitName} />
        {hasEmail && (
          <ColourPicker
            profile={profile}
            currentKey={activeColourKey}
            onPick={handlePickColour}
          />
        )}
        {/* #216: both halves of this account's authentication. Shown per account
            because the claude.ai web session is per account by construction —
            one partition each — and because the code-session token and the web
            session fail in ways that look nothing alike. */}
        <div className="mt-2">
          <AccountWebSession profileId={profile.id} accountName={profile.name} />
        </div>
        {deleteError && (
          <p
            className="text-[11px] text-red mt-1.5"
            role="alert"
            data-testid={`delete-error-${profile.id}`}
          >
            {deleteError}
          </p>
        )}
      </div>
    </div>
  )
}

// ---- main component ---------------------------------------------------------

export default function AccountsPanel({ onAdd }: AccountsPanelProps) {
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
        {/* One ProfileRow per profile; primary shows badge and has no delete */}
        {profiles.map((profile) => (
          <div key={profile.id} className="pt-1">
            <ProfileRow profile={profile} />
          </div>
        ))}
      </div>

      {/* Add another account. Windows-only: on macOS Claude Code keeps its
          OAuth token in the login Keychain, which per-profile HOME redirection
          cannot isolate, so added accounts would silently share one login
          (Mac readiness review 2026-07-02). */}
      {window.electronPlatform === 'darwin' ? (
        <p className="mt-3 text-[11px] text-overlay0 leading-relaxed rounded-lg border border-dashed border-surface1 py-2 px-4">
          Multiple accounts are not available on macOS yet: Claude Code stores its sign-in
          token in the macOS Keychain, which is shared across the whole app, so added
          accounts could not be kept separate. Your single account works exactly as normal.
        </p>
      ) : (
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
      )}

      {/* Informational note - no em dashes */}
      <p className="text-[11px] text-overlay0 leading-relaxed mt-2">
        The email is the account; the name is just a friendly label for you. Signing in or
        out of an added account never touches the others or your default, and memory,
        settings and history stay shared. You pick which account a session runs under when
        it starts.
      </p>
    </Section>
  )
}
