import React, { useEffect, useMemo, useState } from 'react'
import { IDENTITY_COLOR_KEYS, resolveIdentityColor } from '../../../shared/identity-colors'
import type { IdentityColorKey } from '../../../shared/identity-colors'
import { canonicaliseEmail, middleTruncateEmail } from '../../../shared/account-chip-color'
import { useSettingsStore } from '../../stores/settingsStore'
import { useResolvedTheme } from '../../hooks/useThemeController'

const AUTO = '__auto__'
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

// Per-account colour overrides (UAT R4). Detected accounts come from the same
// listKnownEmails source the attribution wizard uses; manual rows let the user
// pre-assign a colour to an account not seen yet. Colours are identity-palette
// KEYS, resolved per-theme, so they stay consistent with session colours.
export default function AccountColoursSection() {
  const overrides = useSettingsStore((s) => s.settings.accountColourOverrides)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const theme = useResolvedTheme()
  const [detected, setDetected] = useState<string[]>([])
  const [addEmail, setAddEmail] = useState('')
  const [addKey, setAddKey] = useState<IdentityColorKey>(IDENTITY_COLOR_KEYS[0])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    window.electronAPI.tokenomics
      .listKnownEmails()
      .then((emails: string[]) => { if (active) setDetected(emails.map(canonicaliseEmail)) })
      .catch(() => { /* listing is best-effort */ })
    return () => { active = false }
  }, [])

  // Union of detected accounts and any manually-added override keys, deduped.
  const rows = useMemo(() => {
    const set = new Set<string>(detected)
    for (const k of Object.keys(overrides ?? {})) set.add(k)
    return Array.from(set).sort()
  }, [detected, overrides])

  const setOverride = (email: string, value: string) => {
    const next = { ...(overrides ?? {}) }
    if (value === AUTO) delete next[email]
    else next[email] = value as IdentityColorKey
    updateSettings({ accountColourOverrides: next })
  }

  const removeRow = (email: string) => {
    const next = { ...(overrides ?? {}) }
    delete next[email]
    updateSettings({ accountColourOverrides: next })
  }

  const onAdd = () => {
    const canon = canonicaliseEmail(addEmail)
    if (!EMAIL_RE.test(canon)) { setError('Enter a valid email address'); return }
    setError(null)
    setOverride(canon, addKey)
    setAddEmail('')
  }

  return (
    <Section>
      <p className="text-[11px] text-overlay0 mb-2 leading-relaxed">
        Give an account a fixed colour. It tints that account's email in the status line and session header.
        Leave a row on Auto to use the automatic colour.
      </p>
      <div className="space-y-1.5">
        {rows.map((email) => (
          <div key={email} className="flex items-center gap-2">
            <Swatch value={overrides?.[email]} dataTestId={`swatch-${email}`} theme={theme}
              onChange={(v) => setOverride(email, v)} label={email} />
            <span className="text-sm text-text truncate min-w-0" title={email}>
              {middleTruncateEmail(email, 34)}
            </span>
            <span className="flex-1" />
            {detected.includes(email)
              ? <span className="text-[10px] text-overlay0 shrink-0">detected</span>
              : (
                <button
                  data-testid={`remove-${email}`}
                  onClick={() => removeRow(email)}
                  className="text-[11px] text-overlay0 hover:text-red transition-colors shrink-0"
                  aria-label={`Remove ${email}`}
                >
                  Remove
                </button>
              )}
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <input
          data-testid="add-email-input"
          value={addEmail}
          onChange={(e) => { setAddEmail(e.target.value); if (error) setError(null) }}
          placeholder="add account email"
          className="bg-crust/60 border border-surface0/80 rounded-lg px-3 py-1.5 text-sm text-text flex-1 focus:outline-none focus:border-blue/50 placeholder:text-overlay0 transition-colors"
        />
        <Swatch value={addKey} dataTestId="add-email-swatch" theme={theme}
          onChange={(v) => setAddKey((v === AUTO ? IDENTITY_COLOR_KEYS[0] : v) as IdentityColorKey)} includeAuto={false} label="new account" />
        <button
          data-testid="add-email-btn"
          onClick={onAdd}
          className="px-3 py-1.5 text-sm bg-surface1 hover:bg-surface2 rounded-lg transition-colors shrink-0"
        >
          Add
        </button>
      </div>
      {error && <p data-testid="add-email-error" className="mt-1 text-[11px] text-red">{error}</p>}
    </Section>
  )
}

function Swatch({ value, onChange, theme, dataTestId, includeAuto = true, label }: {
  value?: IdentityColorKey
  onChange: (v: string) => void
  theme: 'dark' | 'light'
  dataTestId: string
  includeAuto?: boolean
  label?: string
}) {
  return (
    <span className="flex items-center gap-1.5 shrink-0">
      <span className="w-3 h-3 rounded-full border border-surface0/80"
        style={{ background: value ? resolveIdentityColor(value, theme) : 'var(--text-muted)' }} aria-hidden />
      <select
        data-testid={dataTestId}
        value={value ?? (includeAuto ? '__auto__' : IDENTITY_COLOR_KEYS[0])}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label ? `Colour for ${label}` : 'Account colour'}
        className="bg-crust/60 border border-surface0/80 rounded-md px-2 py-1 text-xs text-text focus:outline-none focus:border-blue/50 transition-colors"
      >
        {includeAuto && <option value="__auto__">Auto</option>}
        {IDENTITY_COLOR_KEYS.map((k) => (
          <option key={k} value={k}>{k}</option>
        ))}
      </select>
    </span>
  )
}

// Local section shell matching the General-tab card styling.
function Section({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-surface0/30 border border-surface0/60 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-surface0/40 flex items-center gap-2">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-overlay1 shrink-0">
          <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.2" fill="none" />
          <path d="M8 3a5 5 0 0 1 0 10" fill="currentColor" opacity="0.4" />
        </svg>
        <h3 className="text-xs font-semibold text-subtext0 uppercase tracking-wider">Account Colours</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}
