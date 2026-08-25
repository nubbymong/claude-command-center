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
import {
  DialogOverlay,
  DialogPanel,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogButton,
  DIALOG_INPUT_CLASS,
  DIALOG_INPUT_STYLE,
} from './ui/Dialog'

export default function AccountLaunchGate() {
  const pending = useAccountGateStore((s) => s.queue[0] ?? null)
  const resolveChoice = useAccountGateStore((s) => s.resolveChoice)
  const cancelChoice = useAccountGateStore((s) => s.cancelChoice)
  // #446: on a RESTORED session (the 'ask' resume path) Cancel keeps the
  // session and continues under its saved account — it does NOT discard the
  // tab the way it does for a brand-new launch — so the button says so.
  const isRestore = useAccountGateStore((s) => s.restored.includes(pending?.sessionId ?? ''))
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
  // selectable (never an inactive account). The pinned id is honoured only if
  // it still EXISTS (#446): the 'ask' resume path routes an already-pinned
  // profileId through this gate, and a session pinned to a since-DELETED account
  // would otherwise pre-select an id with no matching <option> — a blank
  // dropdown. A missing pin falls through to primary/first, same as no pin.
  const pinnedStillExists = !!pending?.currentProfileId && profiles.some((p) => p.id === pending.currentProfileId)
  const defaultSelectedId = () =>
    (pinnedStillExists ? pending!.currentProfileId : undefined) ?? profiles.find((p) => p.isPrimary)?.id ?? selectableProfiles[0]?.id ?? ''
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
    <DialogOverlay z="z-[60]" dim={0.5}>
      <DialogPanel width="w-[420px]" ariaLabel="Choose account for this session">
        <DialogHeader
          title="Start session"
          subtitle={<>
            Choose the account for{' '}
            <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{pending.sessionLabel || 'this session'}</span>
          </>}
        />

        <DialogBody>
          {lastUsedProfile && (
            <div
              className="flex items-center gap-2 mb-4 rounded-md px-3 py-2"
              style={{
                background: 'color-mix(in srgb, var(--surface-base) 60%, transparent)',
                border: '1px solid var(--border-subtle)',
              }}
              data-testid="account-launch-lastused"
            >
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: lastUsedDot }}
                aria-hidden
              />
              <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }} title={lastUsedProfile.accountEmail || undefined}>
                {lastUsedLabel}
              </span>
              <span className="text-[10px] uppercase tracking-wide ml-1 shrink-0" style={{ color: 'var(--text-muted)' }}>Last used</span>
              {selected === lastUsedProfile.id ? (
                <span className="ml-auto text-xs shrink-0" style={{ color: 'var(--text-muted)' }}>selected</span>
              ) : (
                <button
                  onClick={() => setSelected(lastUsedProfile.id)}
                  data-testid="account-launch-lastused-use"
                  className="ml-auto text-xs text-[var(--brand)] hover:underline shrink-0 focus-ring rounded"
                >
                  Use →
                </button>
              )}
            </div>
          )}

          <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>Account</label>
          <div className="flex items-center gap-2">
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
              className={DIALOG_INPUT_CLASS.replace('w-full', 'flex-1')}
              style={DIALOG_INPUT_STYLE}
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
        </DialogBody>

        <DialogFooter>
          <DialogButton
            variant="secondary"
            onClick={cancelChoice}
            testId="account-launch-cancel"
            title={isRestore
              ? 'Keep this session and continue under its last account'
              : "Don't launch; close this session tab"}
          >
            {isRestore ? 'Keep last account' : 'Cancel'}
          </DialogButton>
          <DialogButton
            variant="primary"
            onClick={launch}
            testId="account-launch-confirm"
          >
            Launch
          </DialogButton>
        </DialogFooter>
      </DialogPanel>
    </DialogOverlay>
  )
}
