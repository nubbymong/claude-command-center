// src/renderer/components/AccountLaunchGate.tsx
// App-root modal that asks which account a session should launch under, the
// first time it spawns this app-run. Driven by accountGateStore: renders the
// head of the queue, resolves the awaiting spawn on Launch. Fail-open by
// design lives in TerminalView (this component is only shown when a gate was
// genuinely requested). Mouse + keyboard; Enter launches with the selection.
import React, { useState, useEffect } from 'react'
import { useAccountGateStore } from '../stores/accountGateStore'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { useSettingsStore } from '../stores/settingsStore'
import { middleTruncateEmail, resolveAccountName, resolveAccountColourKey } from '../../shared/account-chip-color'
import { useResolvedTheme } from '../hooks/useThemeController'
import { resolveIdentityColor } from '../../shared/identity-colors'
import { isAccountActive } from '../../shared/account-types'

export default function AccountLaunchGate() {
  const pending = useAccountGateStore((s) => s.queue[0] ?? null)
  const resolveChoice = useAccountGateStore((s) => s.resolveChoice)
  const cancelChoice = useAccountGateStore((s) => s.cancelChoice)
  const profiles = useAccountProfilesStore((s) => s.profiles)
  const accountAliases = useSettingsStore((s) => s.settings.accountAliases)
  const accountColourOverrides = useSettingsStore((s) => s.settings.accountColourOverrides)
  const lastUsedAccountId = useSettingsStore((s) => s.settings.lastUsedAccountId)
  const theme = useResolvedTheme()
  // Only active accounts are selectable at launch: an inactive account has been
  // parked and must not be chosen for a new session. The session's own pinned
  // account stays selectable so a session already on it can relaunch, and the
  // primary is always active, so it is always a valid fallback.
  const isSelectable = (p: (typeof profiles)[number]) =>
    isAccountActive(p) || p.id === pending?.currentProfileId
  // If nothing is selectable (a no-primary install where every remaining account
  // was parked, e.g. after deleting the last active one) fall back to all
  // profiles rather than a dead, empty picker -- a choice beats no choice.
  const activeSelectable = profiles.filter(isSelectable)
  const selectableProfiles = activeSelectable.length > 0 ? activeSelectable : profiles
  // Pre-select: the session's pinned profile, else primary, else the first
  // selectable (never an inactive account).
  const defaultSelectedId = () =>
    pending?.currentProfileId ?? profiles.find((p) => p.isPrimary)?.id ?? selectableProfiles[0]?.id ?? ''
  const [selected, setSelected] = useState<string>(defaultSelectedId())

  // Re-seed the selection each time a new session reaches the head of the queue.
  useEffect(() => {
    setSelected(defaultSelectedId())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.sessionId])

  if (!pending) return null

  const launch = () => resolveChoice(selected || undefined)

  // "Last used" line: the account most recently launched, shown regardless of the
  // dropdown value so a new session can adopt it in one click. Only shown when it
  // resolves to a real, SELECTABLE profile — skipped on a first-ever launch, if
  // that account was since deleted, or if it has since been PARKED (inactive): a
  // parked account must not be launchable, and this one-click shortcut bypasses
  // the dropdown, so it has to apply the same isSelectable gate the dropdown does
  // (adversarial review — otherwise Use -> launches a parked account).
  const lastUsedProfile = lastUsedAccountId
    ? profiles.find((p) => p.id === lastUsedAccountId && isSelectable(p))
    : undefined
  const lastUsedLabel = lastUsedProfile
    ? (lastUsedProfile.accountEmail
        ? (() => {
            const r = resolveAccountName(lastUsedProfile.accountEmail, lastUsedProfile.name, accountAliases)
            return r === lastUsedProfile.accountEmail ? middleTruncateEmail(lastUsedProfile.accountEmail) : r
          })()
        : (lastUsedProfile.name || 'New account'))
    : ''
  const lastUsedDot = lastUsedProfile
    ? resolveIdentityColor(
        resolveAccountColourKey(lastUsedProfile.accountEmail, accountColourOverrides, lastUsedProfile.colourKey),
        theme,
      )
    : ''

  // Colour dot for the current selection: user override wins, else the profile's
  // stored colourKey, else neutral mauve.
  const selectedProfile = profiles.find((p) => p.id === selected)
  const selectedDot = resolveIdentityColor(
    resolveAccountColourKey(selectedProfile?.accountEmail, accountColourOverrides, selectedProfile?.colourKey),
    theme,
  )

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-label="Choose account for this session"
    >
      <div className="bg-surface0 rounded-lg p-6 w-[420px] shadow-2xl border border-surface1">
        <h3 className="text-base font-semibold text-text mb-1">Start session</h3>
        <p className="text-xs text-subtext0 mb-4">
          Choose the account for{' '}
          <span className="text-text font-medium">{pending.sessionLabel || 'this session'}</span>
        </p>

        {lastUsedProfile && (
          <div
            className="flex items-center gap-2 mb-4 rounded-md border border-surface1 bg-base/60 px-3 py-2"
            data-testid="account-launch-lastused"
          >
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: lastUsedDot }}
              aria-hidden
            />
            <span className="text-sm text-text font-medium truncate" title={lastUsedProfile.accountEmail || undefined}>
              {lastUsedLabel}
            </span>
            <span className="text-[10px] uppercase tracking-wide text-overlay1 ml-1 shrink-0">Last used</span>
            {selected === lastUsedProfile.id ? (
              <span className="ml-auto text-xs text-overlay1 shrink-0">selected</span>
            ) : (
              <button
                onClick={() => setSelected(lastUsedProfile.id)}
                data-testid="account-launch-lastused-use"
                className="ml-auto text-xs text-blue hover:underline shrink-0 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue/50 rounded"
              >
                Use →
              </button>
            )}
          </div>
        )}

        <label className="block text-xs text-subtext0 mb-1">Account</label>
        <div className="flex items-center gap-2 mb-5">
          <span
            className="w-2.5 h-2.5 rounded-full shrink-0"
            style={{ backgroundColor: selectedDot }}
            aria-hidden
          />
          <select
            autoFocus
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                launch()
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                cancelChoice()
              }
            }}
            data-testid="account-launch-select"
            className="flex-1 bg-base border border-surface1 rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-blue"
          >
            {selectableProfiles.map((p) => {
              // Friendly name wins when set; otherwise the email (or a clear
              // "setup incomplete" hint for a profile still mid-login).
              const resolved = resolveAccountName(p.accountEmail, p.name, accountAliases)
              const label = p.accountEmail
                ? (resolved === p.accountEmail ? middleTruncateEmail(p.accountEmail) : resolved)
                : `${p.name || 'New account'} (setup incomplete)`
              return (
                <option key={p.id} value={p.id} title={p.accountEmail || undefined}>
                  {label}
                </option>
              )
            })}
          </select>
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={cancelChoice}
            data-testid="account-launch-cancel"
            className="px-4 py-1.5 rounded text-sm border border-surface1 text-overlay1 hover:text-text hover:bg-surface1 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-blue/50"
            title="Don't launch; close this session tab"
          >
            Cancel
          </button>
          <button
            onClick={launch}
            data-testid="account-launch-confirm"
            className="px-4 py-1.5 rounded text-sm bg-blue text-crust font-medium hover:bg-blue/90 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-blue/50"
          >
            Launch
          </button>
        </div>
      </div>
    </div>
  )
}
