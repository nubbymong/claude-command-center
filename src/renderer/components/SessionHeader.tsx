import React from 'react'
import { Session, useSessionStore } from '../stores/sessionStore'
import NotesBar from './NotesBar'
import TipPill from './TipPill'
import { resolveIdentityColor, bucketLegacyColorToKey } from '../../shared/identity-colors'
import { useResolvedTheme } from '../hooks/useThemeController'
import { useRegionTypography } from '../hooks/useTypography'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { useAccountAuthStore } from '../stores/accountAuthStore'
import { useSettingsStore } from '../stores/settingsStore'
import { resolveAccountName, resolveAccountColourKey, middleTruncateEmail } from '../../shared/account-chip-color'
import { BrandMark } from './BrandMark'
import { useRestartSession } from '../hooks/useRestartSession'
import { ASK_LABEL } from '../lib/askConductor'

declare const __APP_VERSION__: string

interface Props {
  session: Session
  onShowTip?: () => void
}

/**
 * The left half of the header for the Ask Conductor session: the app monogram,
 * a fixed title, and one line naming WHAT IT KNOWS -- the thing a help session
 * has to say up front, so nobody asks it about their own code and takes the
 * answer seriously. The right half (account/auth pills, notes, tip) is shared
 * with every other session, which is where requirement "account chip" is met.
 */
function AskHeaderLead({ session }: { session: Session }) {
  const { restart } = useRestartSession(session)
  return (
    <>
      <BrandMark className="w-6 h-6 shrink-0" />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
          {ASK_LABEL}
        </span>
        <span className="block text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
          Knows this app at v{__APP_VERSION__} -- features, settings, known issues. Not your code.
        </span>
      </span>
      {/* Restart already marks the session for the resume picker, so this is the
          ordinary "pick an older conversation" path, not a second mechanism. */}
      <button
        data-ux-id="ask-band-history"
        onClick={() => restart()}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium shrink-0 focus-ring transition-colors"
        style={{
          color: 'var(--brand)',
          background: 'color-mix(in srgb, var(--brand) 12%, transparent)',
          border: '1px solid color-mix(in srgb, var(--brand) 42%, transparent)',
        }}
        title="Reopen an earlier Ask Conductor conversation"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 4v4h4" /><path d="M12 8v4l3 2" />
        </svg>
        Past discussions
      </button>
    </>
  )
}

/**
 * Click-to-edit session "work name" for the active session. Shows the current
 * display name (customName || label); clicking swaps to an input that commits
 * on Enter/blur and cancels on Esc. Blank commit reverts to the config label.
 *
 * Uses LOCAL edit state (not the store's renamingSessionId, which drives the
 * tab-bar editor) so triggering rename from the tab/F2 doesn't also pop an
 * editor open here — each surface opens independently, all writing customName.
 */
function SessionNameField({ session }: { session: Session }) {
  const renameSession = useSessionStore((s) => s.renameSession)
  const [editing, setEditing] = React.useState(false)
  const name = session.customName?.trim() || session.label
  const ref = React.useRef<HTMLInputElement>(null)
  const doneRef = React.useRef(false)

  React.useEffect(() => {
    if (!editing) return
    doneRef.current = false
    const el = ref.current
    if (el) { el.focus(); el.select() }
  }, [editing])

  if (editing) {
    return (
      <input
        ref={ref}
        type="text"
        defaultValue={name}
        maxLength={80}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') { doneRef.current = true; renameSession(session.id, (e.currentTarget as HTMLInputElement).value); setEditing(false) }
          else if (e.key === 'Escape') { doneRef.current = true; setEditing(false) }
        }}
        onBlur={(e) => {
          if (doneRef.current) return
          doneRef.current = true
          renameSession(session.id, (e.currentTarget as HTMLInputElement).value)
          setEditing(false)
        }}
        className="min-w-0 max-w-[240px] bg-transparent outline-none border-b border-current text-text text-xs font-medium"
        aria-label="Session name"
      />
    )
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title={`${name} — click to rename`}
      className="max-w-[240px] truncate text-xs font-medium text-text hover:text-mauve transition-colors focus-ring rounded px-0.5"
    >
      {name}
    </button>
  )
}

/**
 * A status pill styled to match the title-bar service pills (Services / Code /
 * Claude.ai / Sentinel): a bordered chip with a coloured dot + label. The label
 * is always shown; an extra status WORD appears only when the state needs
 * attention (like the title bar showing "Degraded" but nothing for "Operational")
 * -- a green dot alone means all-good. `tone` colours the dot (+ the word).
 */
function HeaderPill({
  label, tone, word, title, testId, dotOnly, children,
}: {
  label: React.ReactNode
  tone: string
  word?: string
  title?: string
  testId?: string
  dotOnly?: boolean
  children?: React.ReactNode
}) {
  return (
    <span
      className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-surface0/60 bg-surface0/40 shrink-0"
      title={title}
      data-testid={testId}
    >
      {!dotOnly && <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: tone }} aria-hidden />}
      <span className="text-[10px] font-medium leading-none flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
        {label}
        {word && <span style={{ color: tone }}>{word}</span>}
      </span>
      {children}
    </span>
  )
}

/**
 * The session's GitHub connection, as a title-bar-style pill. The repo slug is
 * shown ON HOVER (title), never inline -- the pill just reads "GitHub" with a
 * connection dot, so it sits quietly beside the Claude pills at the same weight.
 */
function SessionGitHubPill({ session }: { session: Session }) {
  const gi = session.githubIntegration
  const slug = gi?.repoSlug
  if (!slug) return null
  const connected = !!gi?.enabled
  const tone = connected ? 'var(--status-success)' : 'var(--text-muted)'
  return (
    <HeaderPill
      label={
        <span className="flex items-center gap-1">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 2C6.48 2 2 6.48 2 12c0 4.42 2.87 8.17 6.84 9.5.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 22 12c0-5.52-4.48-10-10-10z"/></svg>
          <span>GitHub</span>
        </span>
      }
      tone={tone}
      word={connected ? undefined : 'detected'}
      title={`GitHub: ${slug}${connected ? ' (connected)' : ' (detected — not connected)'}`}
      testId="session-pill-github"
    />
  )
}

/**
 * The session's status cluster (right side of the header), styled to complement
 * the title-bar service pills. Order: account · claude.ai · Claude Code | GitHub.
 * The account pill names the Claude account this session runs as; the two auth
 * pills say whether it is signed in / connected (a green dot = good, a word only
 * when action is needed). GitHub follows a separator, its repo slug on hover.
 * Status comes from the shared accountAuthStore, fetched on activate + after any
 * sign-in/out + manual refresh (never polled — the Claude Code check is heavy).
 */
function SessionAuthPills({ session }: { session: Session }) {
  const primary = useAccountProfilesStore((s) => s.profiles.find((p) => p.isPrimary))
  const refresh = useAccountAuthStore((s) => s.refresh)
  const accountAliases = useSettingsStore((s) => s.settings.accountAliases)
  const accountColourOverrides = useSettingsStore((s) => s.settings.accountColourOverrides)
  const theme = useResolvedTheme()
  // Only LOCAL Claude sessions carry per-session Claude Code creds + a claude.ai
  // web session. SSH (remote creds), Codex (not profile-scoped) and shell-only
  // sessions show nothing — same gate the context-menu auth items use.
  const applies = !session.shellOnly && session.sessionType === 'local' && (session.provider ?? 'claude') === 'claude'
  const profileId = session.profileId ?? primary?.id
  const profile = useAccountProfilesStore((s) => (profileId ? s.profiles.find((p) => p.id === profileId) : undefined))
  const status = useAccountAuthStore((s) => (profileId ? s.byProfile[profileId] : undefined))

  React.useEffect(() => {
    // This header renders only the ACTIVE session, so mounting/param-change is
    // "on activate". Re-fetch when the session or its account changes.
    if (applies && profileId) void refresh(profileId)
  }, [applies, profileId, refresh, session.id])

  const gitHub = <SessionGitHubPill session={session} />
  if (!applies || !profileId) {
    // Non-Claude sessions still show the GitHub pill (with its own leading
    // separator) so the right cluster stays consistent.
    return session.githubIntegration?.repoSlug
      ? (<><div className="w-px h-4 bg-surface1 shrink-0" />{gitHub}</>)
      : null
  }

  // Until the FIRST successful read (fetchedAt set) the status is UNKNOWN — the
  // very first render precedes the fetch effect, and a failed first fetch leaves
  // no result either. Never paint "signed out"/"not connected" for unknown: show
  // "…" while pending and "unknown" (error in the tooltip) after a failure.
  const known = status?.fetchedAt !== undefined
  const pending = !known && !status?.error
  const cliOk = status?.cliAuthed === true
  const web = status?.web
  const errorSuffix = status?.error ? ` — could not read status: ${status.error}` : ''

  // Account pill: the Claude account this session runs as (name/alias, else a
  // middle-truncated email), with the account's identity colour. Full email on
  // hover.
  const email = profile?.accountEmail ?? ''
  const accountName = email
    ? (() => {
        const r = resolveAccountName(email, profile?.name, accountAliases)
        return r === email ? middleTruncateEmail(email) : r
      })()
    : (profile?.name || 'Account')
  const accountTone = resolveIdentityColor(
    resolveAccountColourKey(email, accountColourOverrides, profile?.colourKey),
    theme,
  )

  // A green dot = all good, no word; the word appears only when action is needed
  // (signed out / not connected / expired / unknown), mirroring the title bar.
  const codeTone = known && cliOk ? 'var(--status-success)' : known ? 'var(--text-muted)' : 'var(--text-muted)'
  const codeWord = !known ? (pending ? '…' : 'unknown') : cliOk ? undefined : 'signed out'
  const aiTone = !known ? 'var(--text-muted)' : web === 'active' ? 'var(--status-success)' : web === 'expired' ? 'var(--status-warning)' : 'var(--text-muted)'
  const aiWord = !known ? (pending ? '…' : 'unknown') : web === 'active' ? undefined : web === 'expired' ? 'expired' : 'not connected'

  const doRefresh = () => { if (profileId) void refresh(profileId, { force: true }) }

  return (
    <>
      <HeaderPill
        label={accountName}
        tone={accountTone}
        title={email ? `Account: ${email}` : 'This session’s Claude account'}
        testId="session-pill-account"
      />
      <HeaderPill
        label="claude.ai"
        tone={aiTone}
        word={aiWord}
        title={`claude.ai web session for this session's account${errorSuffix}`}
        testId="session-pill-claudeai"
      />
      <HeaderPill
        label="Claude Code"
        tone={codeTone}
        word={codeWord}
        title={`Claude Code sign-in for this session's account${errorSuffix}`}
        testId="session-pill-claudecode"
      >
        <button
          onClick={doRefresh}
          disabled={!!status?.loading}
          title="Refresh auth status"
          aria-label="Refresh auth status"
          className="ml-0.5 opacity-50 hover:opacity-100 disabled:opacity-30 focus-ring rounded"
          data-testid="session-pill-refresh"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg>
        </button>
      </HeaderPill>
      {/* Separator, then GitHub — its own group, slug on hover. */}
      <div className="w-px h-4 bg-surface1 shrink-0" />
      {gitHub}
    </>
  )
}

export default function SessionHeader({ session, onShowTip }: Props) {
  const theme = useResolvedTheme()
  const headerType = useRegionTypography('header')
  // Resolve identity per-theme (like every other migrated surface) so the accent
  // theme-shifts and a pre-migration reserved hue never leaks through.
  const identity = resolveIdentityColor(session.identityColorKey ?? bucketLegacyColorToKey(session.color), theme)
  // Orientation info folded in from the former standalone RepoBreadcrumb strip:
  // working directory (middle) + GitHub repo slug/connection (right). One bar
  // instead of two.
  const cwd = session.workingDirectory || ''
  // Ask Conductor wears a banded header instead of the ordinary name + cwd row:
  // it is the app answering, not one of your projects, and its working directory
  // (the staged help workspace) is an implementation detail nobody needs to read.
  const isAsk = session.kind === 'ask'
  return (
    <div
      data-ux-id={isAsk ? 'ask-band' : undefined}
      className="flex items-center gap-3 px-4 py-2 border-b shrink-0 relative"
      style={{
        background: isAsk
          ? 'linear-gradient(180deg, color-mix(in srgb, var(--brand) 16%, var(--surface-panel)), var(--surface-panel))'
          : 'var(--surface-panel)',
        borderColor: isAsk ? 'color-mix(in srgb, var(--brand) 26%, var(--border-subtle))' : 'var(--border-subtle)',
        ...headerType,
      }}
    >
      {/* Session-color accent line that fades out toward the right --
          the gradient stops before fully transparent at ~70% so the
          colour reads strong on the left and dissolves toward the right. */}
      <div
        className="absolute top-0 left-0 right-0 h-[2px] pointer-events-none"
        style={{ background: `linear-gradient(to right, ${identity} 0%, ${identity}80 15%, transparent 55%)` }}
        aria-hidden
      />
      {isAsk ? <AskHeaderLead session={session} /> : (
        <>
          {/* Color dot: at-a-glance session identifier */}
          <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: identity }} />

          {/* Editable work name for this session (F2 / double-click tab / here). */}
          <SessionNameField session={session} />

          {/* Working directory — flexible middle, truncates first on narrow widths.
              (Passive orientation, no actions — formerly RepoBreadcrumb.) */}
          <span className="font-mono text-[11px] truncate min-w-0 flex-1" style={{ color: 'var(--text-muted)' }} title={cwd}>
            {cwd}
          </span>
        </>
      )}

      {session.sessionType === 'ssh' && session.sshConfig && (
        <span className="flex items-center gap-1.5 shrink-0">
          <span className="text-xs text-mauve">SSH: {session.sshConfig.username}@{session.sshConfig.host}</span>
          {/* item 8: persistence indicator. Only shown once main has reported a
              definite status for this session (undefined = not yet known). */}
          {/* Rendered through the shared HeaderPill (#291's title-bar-style pill
              system) so the SSH pills sit at the same weight as the account /
              GitHub pills instead of carrying their own copy of the chrome. */}
          {session.sshTmuxPersistent === true && (
            <HeaderPill
              label={
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/></svg>
              }
              tone="var(--status-success)"
              word="persistent"
              dotOnly
              title="This remote session runs inside tmux — a dropped connection stays alive and reconnecting resumes it in place."
              testId="ssh-persistent-pill"
            />
          )}
          {session.sshTmuxPersistent === false && (
            <HeaderPill
              label="not persistent"
              tone="var(--text-muted)"
              dotOnly
              title="This remote session is not persistent — a dropped connection ends it; reconnecting resumes the conversation via --continue."
              testId="ssh-nonpersistent-pill"
            />
          )}
          {/* item 10: the account the REMOTE session is signed in as (descriptor
              only). Distinct from the local SessionAuthPills, which never apply
              to SSH. */}
          {session.sshRemoteAccount && (
            <HeaderPill
              label={<span className="truncate max-w-[140px]">{session.sshRemoteAccount}</span>}
              tone="var(--color-mauve)"
              title={`Remote Claude account: ${session.sshRemoteAccount}`}
              testId="ssh-remote-account-pill"
            />
          )}
        </span>
      )}

      {/* Right cluster: account · claude.ai · Claude Code | GitHub — styled to
          match the title-bar service pills (GitHub slug shows on hover). */}
      <SessionAuthPills session={session} />

      {/* Separator before notes */}
      <div className="w-px h-4 bg-surface1 shrink-0" />

      {/* Secret notes */}
      <NotesBar configId={session.configId} />

      {onShowTip && <TipPill onClick={onShowTip} />}
    </div>
  )
}
