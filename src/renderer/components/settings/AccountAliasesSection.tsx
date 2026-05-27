import React, { useState } from 'react'
import {
  canonicaliseEmail,
  isValidAliasLength,
  isValidEmailShape,
  type AccountAlias,
} from '../../../shared/account-alias'
import { useSettingsStore } from '../../stores/settingsStore'
import { useSessionStore } from '../../stores/sessionStore'

// v1.5.9 -- replaces the deleted Account Colours section. Surfaces a small
// CRUD list of {email, alias} rows the user maintains by hand. The alias is
// looked up by canonical email key at SessionRow render time, so renaming an
// alias here updates every tagged session label without touching individual
// session records. Removing a row clears the tag from any matching sessions
// so the sidebar does not show "personal" pointing at a now-undefined entry.
export default function AccountAliasesSection() {
  const aliases = useSettingsStore((s) => s.settings.accountAliases) ?? []
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [addEmail, setAddEmail] = useState('')
  const [addAlias, setAddAlias] = useState('')
  const [error, setError] = useState<string | null>(null)

  const persistList = (next: AccountAlias[]) => {
    updateSettings({ accountAliases: next })
  }

  const removeRow = (email: string) => {
    const canon = canonicaliseEmail(email)
    const next = aliases.filter((a) => canonicaliseEmail(a.email) !== canon)
    persistList(next)
    // Clear the alias tag from any sessions that referenced this email so
    // they go back to "(none)" in the sidebar instead of pointing at a
    // removed row. The store dispatch is per-session because updateSession
    // is keyed.
    const sessionState = useSessionStore.getState()
    for (const s of sessionState.sessions) {
      if (s.accountAliasEmail && canonicaliseEmail(s.accountAliasEmail) === canon) {
        sessionState.updateSession(s.id, { accountAliasEmail: undefined })
      }
    }
  }

  const onAdd = () => {
    const canon = canonicaliseEmail(addEmail)
    if (!isValidEmailShape(canon)) {
      setError('Enter a valid email address')
      return
    }
    if (!isValidAliasLength(addAlias)) {
      setError('Alias must be 1 to 16 characters')
      return
    }
    if (aliases.some((a) => canonicaliseEmail(a.email) === canon)) {
      setError('That email is already in the list')
      return
    }
    setError(null)
    persistList([...aliases, { email: canon, alias: addAlias.trim() }])
    setAddEmail('')
    setAddAlias('')
  }

  return (
    <Section>
      <p className="text-[11px] text-overlay0 mb-2 leading-relaxed">
        Tag any session with an account alias by right-clicking the session row.
        Aliases are display-only; CCC does not switch accounts in Claude itself.
      </p>
      <div data-testid="account-aliases-section" className="space-y-1.5">
        {aliases.map((row) => (
          <div key={canonicaliseEmail(row.email)} className="flex items-center gap-2">
            <span className="text-sm text-text truncate min-w-0 flex-1" title={row.email}>
              {row.email}
            </span>
            <span
              className="text-xs text-subtext0 px-2 py-0.5 rounded bg-surface0/60 border border-surface0/80 shrink-0"
              data-testid={`alias-label-${canonicaliseEmail(row.email)}`}
            >
              {row.alias}
            </span>
            <button
              data-testid={`remove-${canonicaliseEmail(row.email)}`}
              onClick={() => removeRow(row.email)}
              className="text-[11px] text-overlay0 hover:text-red transition-colors shrink-0"
              aria-label={`Remove ${row.email}`}
            >
              Remove
            </button>
          </div>
        ))}
        {aliases.length === 0 && (
          <p className="text-[11px] text-overlay0 italic">No aliases yet -- add one below.</p>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <input
          data-testid="add-email-input"
          value={addEmail}
          onChange={(e) => { setAddEmail(e.target.value); if (error) setError(null) }}
          placeholder="account email"
          className="bg-crust/60 border border-surface0/80 rounded-lg px-3 py-1.5 text-sm text-text flex-1 focus:outline-none focus:border-blue/50 placeholder:text-overlay0 transition-colors"
        />
        <input
          data-testid="add-alias-input"
          value={addAlias}
          onChange={(e) => { setAddAlias(e.target.value); if (error) setError(null) }}
          placeholder="alias"
          maxLength={16}
          className="bg-crust/60 border border-surface0/80 rounded-lg px-3 py-1.5 text-sm text-text w-28 focus:outline-none focus:border-blue/50 placeholder:text-overlay0 transition-colors"
        />
        <button
          data-testid="add-alias-btn"
          onClick={onAdd}
          className="px-3 py-1.5 text-sm bg-surface1 hover:bg-surface2 rounded-lg transition-colors shrink-0"
        >
          Save
        </button>
      </div>
      {error && (
        <p data-testid="add-alias-error" className="mt-1 text-[11px] text-red">{error}</p>
      )}
    </Section>
  )
}

// Local section shell matching the General-tab card styling -- mirrors the
// shape of the deleted AccountColoursSection so the visual rhythm of the
// page is preserved.
function Section({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-surface0/30 border border-surface0/60 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-surface0/40 flex items-center gap-2">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-overlay1 shrink-0">
          <circle cx="8" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
          <path d="M3 13c0-2.5 2.25-4 5-4s5 1.5 5 4" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
        </svg>
        <h3 className="text-xs font-semibold text-subtext0 uppercase tracking-wider">Account Aliases</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}
