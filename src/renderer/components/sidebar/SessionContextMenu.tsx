import React, { useRef, useState } from 'react'
import { Session } from '../../stores/sessionStore'
import { useClickOutside } from '../../hooks/useClickOutside'
import type { AccountProfile } from '../../../shared/account-types'
import { resolveAccountName, middleTruncateEmail } from '../../../shared/account-chip-color'

interface SessionContextMenuProps {
  x: number
  y: number
  session: Session
  hasGroup: boolean
  onRename: () => void
  onRemoveFromGroup: () => void
  onClose: () => void
  onDismiss: () => void
  /** Multi-account switch: gated by the caller. When false the item is hidden. */
  canSwitchAccount?: boolean
  /** All known account profiles, for the Switch Account sub-chooser. */
  profiles?: AccountProfile[]
  /** User aliases (canonical email -> name), for friendly labels. */
  accountAliases?: Record<string, string>
  /** Switch this session to the chosen account (undefined = default account).
   *  No-op upstream when it equals the current account. */
  onSwitchAccount?: (profileId: string | undefined) => void
  /** #216: open claude.ai artifacts as THIS session's account. Hidden when undefined. */
  onOpenArtifacts?: () => void
  /** #216: acquire this account's claude.ai web session (opens the system browser). */
  onAuthenticateWeb?: () => void
  /** #216: sign the CODE session in — writes /login into this session's own terminal. */
  onSignInCode?: () => void
  /** True when this account already holds a claude.ai web session; drives the
   *  artifacts item's enabled state and the wording of the authenticate item. */
  hasWebSession?: boolean
}

export default function SessionContextMenu({
  x, y, session, hasGroup, onRename, onRemoveFromGroup, onClose, onDismiss,
  canSwitchAccount, profiles, accountAliases, onSwitchAccount,
  onOpenArtifacts, onAuthenticateWeb, onSignInCode, hasWebSession,
}: SessionContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  useClickOutside(menuRef, onDismiss)
  const [accountOpen, setAccountOpen] = useState(false)

  const showSwitch = !!canSwitchAccount && !!profiles && profiles.length > 1 && !!onSwitchAccount

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

      {/* #216: account actions, reachable from the session itself. If artifacts
          will not open, the fix is the next item down rather than a trip to
          Settings — which is the whole reason these live here. */}
      {(onOpenArtifacts || onAuthenticateWeb || onSignInCode) && (
        <>
          <div className="my-1 border-t border-surface1" />
          {onOpenArtifacts && (
            <button
              onClick={() => { onOpenArtifacts(); onDismiss() }}
              disabled={!hasWebSession}
              title={hasWebSession ? 'Open this account’s artifacts on claude.ai' : 'Authenticate claude.ai first'}
              className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 disabled:opacity-40 disabled:hover:bg-transparent transition-colors flex items-center gap-2"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
                <rect x="1.5" y="2" width="9" height="8" rx="1.2"/>
                <path d="M1.5 4.5h9" strokeLinecap="round"/>
              </svg>
              Open artifacts
            </button>
          )}
          {onAuthenticateWeb && (
            <button
              onClick={() => { onAuthenticateWeb(); onDismiss() }}
              className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors flex items-center gap-2"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
                <circle cx="6" cy="6" r="4.5"/>
                <path d="M1.5 6h9M6 1.5c1.5 1.6 1.5 7.4 0 9M6 1.5c-1.5 1.6-1.5 7.4 0 9" strokeLinecap="round"/>
              </svg>
              {hasWebSession ? 'Re-authenticate claude.ai...' : 'Authenticate claude.ai...'}
            </button>
          )}
          {onSignInCode && (
            <button
              onClick={() => { onSignInCode(); onDismiss() }}
              title="Runs /login in this session’s terminal"
              className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors flex items-center gap-2"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
                <path d="M7 1.5h2.5a1 1 0 011 1v7a1 1 0 01-1 1H7" strokeLinecap="round"/>
                <path d="M5 8.5L7.5 6 5 3.5M7.5 6H1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Sign in to Claude Code
            </button>
          )}
        </>
      )}

      {showSwitch && (
        <>
          <div className="my-1 border-t border-surface1" />
          <button
            onClick={() => setAccountOpen((o) => !o)}
            className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors flex items-center gap-2"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
              <circle cx="6" cy="4" r="2.2"/>
              <path d="M1.8 10.5c0-2 1.9-3.3 4.2-3.3s4.2 1.3 4.2 3.3" strokeLinecap="round"/>
            </svg>
            <span className="flex-1">Switch Account</span>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" style={{ transform: accountOpen ? 'rotate(90deg)' : undefined, transition: 'transform 150ms' }}>
              <path d="M3.5 2.5L6.5 5l-3 2.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          {accountOpen && (
            <div className="pl-2">
              {profiles!.map((p) => (
                <button
                  key={p.id}
                  onClick={() => { onSwitchAccount?.(p.id); onDismiss() }}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-surface1 transition-colors flex items-center gap-2"
                  style={{ color: p.id === session.profileId ? 'var(--color-text)' : 'var(--color-subtext0)' }}
                  title={p.accountEmail}
                >
                  <span className="w-3 shrink-0 text-green">{p.id === session.profileId ? String.fromCodePoint(0x2713) : ''}</span>
                  <span className="flex flex-col min-w-0">
                    <span className="truncate">{resolveAccountName(p.accountEmail, p.name, accountAliases)}</span>
                    <span className="truncate text-overlay0" style={{ fontSize: 10, lineHeight: '13px' }}>{middleTruncateEmail(p.accountEmail)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

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
