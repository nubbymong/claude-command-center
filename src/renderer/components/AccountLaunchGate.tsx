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
import { middleTruncateEmail, resolveAccountName } from '../../shared/account-chip-color'
import { useResolvedTheme } from '../hooks/useThemeController'
import { resolveIdentityColor } from '../../shared/identity-colors'

export default function AccountLaunchGate() {
  const pending = useAccountGateStore((s) => s.queue[0] ?? null)
  const resolveChoice = useAccountGateStore((s) => s.resolveChoice)
  const profiles = useAccountProfilesStore((s) => s.profiles)
  const accountAliases = useSettingsStore((s) => s.settings.accountAliases)
  const theme = useResolvedTheme()
  // Pre-select: use the session's pinned profile, otherwise fall back to primary.
  const primaryId = profiles.find((p) => p.isPrimary)?.id ?? profiles[0]?.id ?? ''
  const [selected, setSelected] = useState<string>(pending?.currentProfileId ?? primaryId)

  // Re-seed the selection each time a new session reaches the head of the queue.
  useEffect(() => {
    const pid = pending?.currentProfileId ?? profiles.find((p) => p.isPrimary)?.id ?? profiles[0]?.id ?? ''
    setSelected(pid)
  }, [pending?.sessionId])

  if (!pending) return null

  const launch = () => resolveChoice(selected || undefined)

  // Colour dot for the current selection (fallback to neutral mauve).
  const selectedDot = resolveIdentityColor(
    profiles.find((p) => p.id === selected)?.colourKey ?? 'mauve',
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
            }}
            data-testid="account-launch-select"
            className="flex-1 bg-base border border-surface1 rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-blue"
          >
            {profiles.map((p) => {
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

        <div className="flex justify-end">
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
