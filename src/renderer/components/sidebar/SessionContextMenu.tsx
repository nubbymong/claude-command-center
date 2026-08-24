import React, { useRef, useState } from 'react'
import { Session } from '../../stores/sessionStore'
import { useClickOutside } from '../../hooks/useClickOutside'
import { isAccountActive, type AccountProfile } from '../../../shared/account-types'
import { resolveAccountName, middleTruncateEmail } from '../../../shared/account-chip-color'
import { pinMenuLabel, PIN_WHILE_RUNNING_HINT } from './sessionsPanelState'

interface SessionContextMenuProps {
  x: number
  y: number
  session: Session
  hasGroup: boolean
  onRename: () => void
  onRemoveFromGroup: () => void
  onClose: () => void
  onDismiss: () => void
  /** Pin/unpin the session's CONFIG to Quick Start (design pass 2026-08-24).
   *  Absent for config-less sessions (Ask, adopted shells) — item hidden. The
   *  hint notes the deferral: a running pin quick-starts after close. */
  configPinned?: boolean
  onPinConfig?: () => void
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
  /** True when this account's Claude Code CLI is already signed in; disables the
   *  "Sign in to Claude Code" item so it isn't offered when it would be a no-op. */
  codeSignedIn?: boolean
}

export default function SessionContextMenu({
  x, y, session, hasGroup, onRename, onRemoveFromGroup, onClose, onDismiss,
  configPinned, onPinConfig,
  canSwitchAccount, profiles, accountAliases, onSwitchAccount,
  onOpenArtifacts, onAuthenticateWeb, onSignInCode, hasWebSession, codeSignedIn,
}: SessionContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  useClickOutside(menuRef, onDismiss)
  const [accountOpen, setAccountOpen] = useState(false)

  const showSwitch = !!canSwitchAccount && !!profiles && profiles.length > 1 && !!onSwitchAccount

  return (
    <div
      ref={menuRef}
      className="fixed z-50 rounded-lg shadow-xl py-1 min-w-[180px]"
      style={{ left: x, top: y, background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
    >
      <button
        onClick={onRename}
        className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-overlay)] transition-colors flex items-center gap-2"
        style={{ color: 'var(--text-primary)' }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M8.5 1.5l2 2-7 7H1.5v-2z"/></svg>
        Rename
      </button>
      {onPinConfig && (
        <>
          <button
            onClick={onPinConfig}
            className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-overlay)] transition-colors flex items-center gap-2"
            style={{ color: 'var(--text-primary)' }}
            data-testid="session-ctx-pin"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="text-yellow" aria-hidden>
              <path d="M13 2L3 14h7l-1 8 11-13h-8z" />
            </svg>
            {pinMenuLabel(configPinned)}
          </button>
          {!configPinned && (
            <div className="px-3 pb-1 pl-8 text-[10px] leading-snug" style={{ color: 'var(--text-muted)' }}>
              {PIN_WHILE_RUNNING_HINT}
            </div>
          )}
        </>
      )}
      {hasGroup && (
        <button
          onClick={onRemoveFromGroup}
          className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-overlay)] transition-colors flex items-center gap-2"
          style={{ color: 'var(--text-primary)' }}
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
          <div className="my-1 border-t" style={{ borderColor: 'var(--border-subtle)' }} />
          {onOpenArtifacts && (
            <button
              onClick={() => { onOpenArtifacts(); onDismiss() }}
              disabled={!hasWebSession}
              title={hasWebSession ? 'Open this account’s artifacts on claude.ai' : 'Authenticate claude.ai first'}
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-overlay)] disabled:opacity-40 disabled:hover:bg-transparent transition-colors flex items-center gap-2"
              style={{ color: 'var(--text-primary)' }}
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
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-overlay)] transition-colors flex items-center gap-2"
              style={{ color: 'var(--text-primary)' }}
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
              onClick={() => { if (codeSignedIn) return; onSignInCode(); onDismiss() }}
              disabled={codeSignedIn}
              title={codeSignedIn ? 'Already signed in to Claude Code for this account' : 'Runs /login in this session’s terminal'}
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-overlay)] disabled:opacity-40 disabled:hover:bg-transparent transition-colors flex items-center gap-2"
              style={{ color: 'var(--text-primary)' }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
                <path d="M7 1.5h2.5a1 1 0 011 1v7a1 1 0 01-1 1H7" strokeLinecap="round"/>
                <path d="M5 8.5L7.5 6 5 3.5M7.5 6H1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              {codeSignedIn ? 'Signed in to Claude Code' : 'Sign in to Claude Code'}
            </button>
          )}
        </>
      )}

      {showSwitch && (
        <>
          <div className="my-1 border-t" style={{ borderColor: 'var(--border-subtle)' }} />
          <button
            onClick={() => setAccountOpen((o) => !o)}
            className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-overlay)] transition-colors flex items-center gap-2"
            style={{ color: 'var(--text-primary)' }}
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
              {profiles!.map((p) => {
                const isCurrent = p.id === session.profileId
                // Inactive accounts stay visible but can't be selected. The current
                // account is always shown selectable (choosing it is a harmless no-op)
                // even in the edge case where it was deactivated while in use.
                const selectable = isAccountActive(p) || isCurrent
                return (
                  <button
                    key={p.id}
                    disabled={!selectable}
                    onClick={() => { if (selectable) { onSwitchAccount?.(p.id); onDismiss() } }}
                    className={`w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 ${selectable ? 'hover:bg-[var(--surface-overlay)]' : 'cursor-default'}`}
                    style={{ color: !selectable ? 'var(--text-muted)' : (isCurrent ? 'var(--text-primary)' : 'var(--text-secondary)') }}
                    title={selectable ? p.accountEmail : `${p.accountEmail} (inactive)`}
                  >
                    <span className="w-3 shrink-0" style={{ color: 'var(--status-success)' }}>{isCurrent ? String.fromCodePoint(0x2713) : ''}</span>
                    <span className="flex flex-col min-w-0">
                      <span className="truncate">
                        {resolveAccountName(p.accountEmail, p.name, accountAliases)}
                        {!isAccountActive(p) && <span style={{ color: 'var(--text-muted)' }}> · inactive</span>}
                      </span>
                      <span className="truncate" style={{ fontSize: 10, lineHeight: '13px', color: 'var(--text-muted)' }}>{middleTruncateEmail(p.accountEmail)}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </>
      )}

      <div className="my-1 border-t" style={{ borderColor: 'var(--border-subtle)' }} />
      <button
        onClick={onClose}
        className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-overlay)] transition-colors flex items-center gap-2"
        style={{ color: 'var(--status-danger)' }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
        Close Session
      </button>
    </div>
  )
}
