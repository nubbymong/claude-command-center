import React from 'react'
import type { IdentityColorKey } from '../../shared/identity-colors'
import { resolveIdentityColor } from '../../shared/identity-colors'
import { resolveAccountChipColorKey, middleTruncateEmail } from '../../shared/account-chip-color'
import { useSettingsStore } from '../stores/settingsStore'
import { useResolvedTheme } from '../hooks/useThemeController'

interface Props {
  email?: string
  /** Statusline-provided colour key (main computed it via colourForEmail). */
  statuslineColour?: IdentityColorKey
  className?: string
  /** Max characters before middle-truncation. */
  max?: number
}

// Coloured account-email chip (UAT R4). A small filled dot in the resolved
// identity colour, then the email (middle-truncated, full address in title).
// Colour precedence: user override -> statusline colour -> neutral.
export default function AccountEmailChip({ email, statuslineColour, className, max = 28 }: Props) {
  const overrides = useSettingsStore((s) => s.settings.accountColourOverrides)
  const theme = useResolvedTheme()
  if (!email) return null
  const key = resolveAccountChipColorKey(email, statuslineColour, overrides)
  const color = resolveIdentityColor(key, theme)
  return (
    <span
      data-testid="account-chip"
      className={`flex items-center gap-1.5 shrink-0 min-w-0 ${className ?? ''}`}
      title={email}
    >
      <span
        data-testid="account-chip-dot"
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ background: color }}
        aria-hidden
      />
      <span className="truncate" style={{ color: 'var(--text-secondary)' }}>
        {middleTruncateEmail(email, max)}
      </span>
    </span>
  )
}
