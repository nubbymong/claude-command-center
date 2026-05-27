import React, { useRef } from 'react'
import { Session, useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useClickOutside } from '../../hooks/useClickOutside'
import { canonicaliseEmail } from '../../../shared/account-alias'

interface SessionContextMenuProps {
  x: number
  y: number
  session: Session
  hasGroup: boolean
  onRename: () => void
  onRemoveFromGroup: () => void
  onClose: () => void
  onDismiss: () => void
  /** v1.5.9: navigate to Settings > General so the user can edit the alias
   *  list. Wired by Sidebar -> App so the parent owns view switching; we just
   *  emit the intent and dismiss. */
  onNavigateToAliases?: () => void
}

// The menu uses an inline section idiom rather than a hover-out submenu --
// the existing menu is a flat vertical list, and matching that keeps the
// UX coherent (one click target depth, no nested popovers to manage). The
// inline form also makes the "Display label only" disclaimer easy to keep
// above the items where the user reads it before clicking.
export default function SessionContextMenu({
  x, y, session, hasGroup, onRename, onRemoveFromGroup, onClose, onDismiss, onNavigateToAliases,
}: SessionContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  useClickOutside(menuRef, onDismiss)
  const aliases = useSettingsStore((s) => s.settings.accountAliases) ?? []
  const updateSession = useSessionStore((s) => s.updateSession)
  const currentAliasKey = session.accountAliasEmail
    ? canonicaliseEmail(session.accountAliasEmail)
    : null

  const setAlias = (email: string | null) => {
    updateSession(session.id, { accountAliasEmail: email ?? undefined })
    onDismiss()
  }

  const onEditAliases = () => {
    onNavigateToAliases?.()
    onDismiss()
  }

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-surface0 border border-surface1 rounded-lg shadow-xl py-1 min-w-[180px]"
      style={{ left: x, top: y }}
    >
      <button
        onClick={onRename}
        className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors flex items-center gap-2"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M8.5 1.5l2 2-7 7H1.5v-2z"/></svg>
        Rename
      </button>
      {hasGroup && (
        <button
          onClick={onRemoveFromGroup}
          className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors flex items-center gap-2"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
            <path d="M4 6h4" strokeLinecap="round"/>
            <rect x="1" y="1" width="10" height="10" rx="1.5"/>
          </svg>
          Remove from Group
        </button>
      )}

      {/* Account alias section -- divider + header + disclaimer + items.
          The disclaimer ("Display label only") makes the menu's intent clear
          before the user clicks: this tags the row, not Claude's auth. */}
      <div className="my-1 border-t border-surface1" />
      <div className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wider text-overlay0">Account</div>
      <p className="px-3 pb-1 text-[10px] text-overlay0 leading-snug">
        Display label only -- CCC does not change Claude's login.
      </p>
      <AliasItem
        testId="account-alias-none"
        label="(none)"
        selected={currentAliasKey == null}
        onClick={() => setAlias(null)}
      />
      {aliases.map((row) => {
        const key = canonicaliseEmail(row.email)
        return (
          <AliasItem
            key={key}
            testId={`account-alias-${key}`}
            label={row.alias}
            sublabel={row.email}
            selected={currentAliasKey === key}
            onClick={() => setAlias(key)}
          />
        )
      })}
      <button
        data-testid="account-alias-edit"
        onClick={onEditAliases}
        className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors flex items-center gap-2"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M2 9V6l5-5 3 3-5 5H2z"/></svg>
        Edit aliases…
      </button>

      <div className="my-1 border-t border-surface1" />
      <button
        onClick={onClose}
        className="w-full text-left px-3 py-1.5 text-xs text-red hover:bg-surface1 transition-colors flex items-center gap-2"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
        Close Session
      </button>
    </div>
  )
}

interface AliasItemProps {
  testId: string
  label: string
  sublabel?: string
  selected: boolean
  onClick: () => void
}

function AliasItem({ testId, label, sublabel, selected, onClick }: AliasItemProps) {
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors flex items-center gap-2"
    >
      <span
        className="w-2 h-2 rounded-full shrink-0"
        aria-hidden
        style={{ background: selected ? 'var(--accent)' : 'transparent', border: selected ? 'none' : '1px solid var(--border-subtle)' }}
      />
      <span className="truncate">{label}</span>
      {sublabel && (
        <span className="text-overlay0 text-[10px] truncate ml-auto" title={sublabel}>{sublabel}</span>
      )}
    </button>
  )
}
