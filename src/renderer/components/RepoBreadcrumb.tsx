import React from 'react'
import { Session } from '../stores/sessionStore'

// Passive orientation strip (spec section 8): working dir on the left, repo slug
// + connection state on the right. NOT a toolbar -- no actions. Does not repeat
// the active session name (the tab already shows it). The path collapses first
// on narrow widths (min-w-0 truncate); the repo side is shrink-0.
//
// v1.5.9: the v1.5.7 account-email chip was removed. Account labels are now
// user-managed aliases set per session from the sidebar right-click menu.
export default function RepoBreadcrumb({ session }: { session: Session }) {
  const cwd = session.workingDirectory || ''
  const gi = session.githubIntegration
  const slug = gi?.repoSlug
  const connected = !!gi?.enabled && !!slug
  if (!cwd && !slug) return null
  return (
    <div className="flex items-center gap-2 px-4 py-1 text-[11px] border-b shrink-0"
      style={{ background: 'var(--surface-panel)', borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
      <span className="font-mono truncate min-w-0" title={cwd}>{cwd}</span>
      <span className="flex-1" />
      {slug && (
        <span className="flex items-center gap-1.5 shrink-0">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 2C6.48 2 2 6.48 2 12c0 4.42 2.87 8.17 6.84 9.5.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 22 12c0-5.52-4.48-10-10-10z"/></svg>
          <span className="truncate max-w-[180px]" title={gi?.repoUrl || slug}>{slug}</span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: connected ? 'var(--status-success)' : 'var(--text-muted)' }} aria-hidden />
            <span style={{ color: connected ? 'var(--status-success)' : 'var(--text-muted)' }}>{connected ? 'connected' : 'detected'}</span>
          </span>
        </span>
      )}
    </div>
  )
}
