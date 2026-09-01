import React from 'react'
import { Session, useSessionStore } from '../stores/sessionStore'
import { resolveIdentityColor, bucketLegacyColorToKey } from '../../shared/identity-colors'
import { useResolvedTheme } from '../hooks/useThemeController'
import { useRegionTypography } from '../hooks/useTypography'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { sshMappedProfileId } from '../utils/sessionLaunch'
import { useAccountAuthStore, type AccountAuthStatus } from '../stores/accountAuthStore'
import { useSettingsStore } from '../stores/settingsStore'
import { resolveAccountName, resolveAccountNameByEmail, resolveAccountColourKey, middleTruncateEmail } from '../../shared/account-chip-color'
import { BrandMark } from './BrandMark'
import { ContainerGlyph, containerBadgeTitle } from './sidebar/Badges'
import { containerNameOf, resolveTransportBadge } from './sidebar/transportBadge'
import { useRestartSession } from '../hooks/useRestartSession'
import { ASK_LABEL } from '../lib/askConductor'

declare const __APP_VERSION__: string

interface Props {
  session: Session
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
      label="GitHub"
      tone={tone}
      word={connected ? undefined : 'detected'}
      title={`GitHub: ${slug}${connected ? ' (connected)' : ' (detected — not connected)'}`}
      testId="session-pill-github"
    />
  )
}

/**
 * The SSH connection as ONE title-bar-style pill carrying BOTH the connection
 * kind and the remote address -- replacing the old mauve "SSH: user@host" text
 * and the separate persistent / not-persistent pills. THREE kinds now (phase 6,
 * the same truth table the sidebar badges read): the teal container mark when
 * claude runs a hop deeper inside a container, green "SSH-Persistent" when the
 * session is tmux-wrapped (a dropped connection stays alive and reconnecting
 * resumes it in place), neutral "SSH" otherwise. The kind slot is exclusive --
 * a container session is never tmux-wrapped (main forces persistence off), so
 * the old separate container pill beside an "SSH" one said one thing twice.
 * The address (user@host) reads inline in EVERY kind, at a glance, not only on
 * hover: this pill is what guarantees a standard SSH session is never headless.
 */
function SshConnectionPill({ session }: { session: Session }) {
  const ssh = session.sshConfig
  if (!ssh) return null
  const kind = resolveTransportBadge({
    isSsh: session.sessionType === 'ssh',
    ssh,
    persistent: session.sshTmuxPersistent === true,
  })
  const container = kind === 'container' ? containerNameOf(ssh) : undefined
  const persistent = kind === 'persistent'
  const pill = (
    <HeaderPill
      label={kind === 'container' ? <ContainerGlyph size={11} /> : persistent ? 'SSH-Persistent' : 'SSH'}
      tone={kind === 'container' ? 'var(--color-teal)' : persistent ? 'var(--status-success)' : 'var(--text-muted)'}
      dotOnly={kind === 'container'}
      title={
        kind === 'container'
          ? containerBadgeTitle(container)
          : persistent
            ? 'This remote session runs inside tmux — a dropped connection stays alive and reconnecting resumes it in place.'
            : 'Remote session over SSH; a dropped connection ends it and reconnecting resumes via --continue.'
      }
      testId="ssh-connection-pill"
    >
      <span className="font-mono text-[10px] leading-none" style={{ color: 'var(--text-primary)' }}>
        {ssh.username}@{ssh.host}
      </span>
    </HeaderPill>
  )
  // The persistent and container variants also answer to their legacy hooks
  // (`ssh-persistent-pill` / `ssh-docker-pill`). One node can't carry two
  // data-testids, so a display:contents wrapper (no layout box of its own)
  // carries the second hook around the pill; `ssh-connection-pill` stays on the
  // pill itself in ALL THREE states.
  const legacyHook = kind === 'container' ? 'ssh-docker-pill' : persistent ? 'ssh-persistent-pill' : undefined
  return legacyHook ? (
    <span style={{ display: 'contents' }} data-testid={legacyHook}>
      {pill}
    </span>
  ) : (
    pill
  )
}

/**
 * The account · claude.ai · Claude Code (with refresh) pill trio plus the
 * trailing GitHub group. Shared by a LOCAL Claude session and an SSH session
 * whose remote account maps to a local profile: the claude.ai / Claude Code
 * checks are local-profile-scoped, so once a remote session is mapped to a local
 * profile the same set applies (harmonise-remote). The account pill's
 * label/tone/title are passed in because they differ — a remote session names
 * its account "Remote Claude account: …". `status` is the accountAuthStore entry
 * for `profileId`; `gitHubTail` is the already-assembled trailing group (its own
 * leading separator + the GitHub pill, or null).
 */
function AccountAuthPillSet({
  accountLabel, accountTone, accountTitle, status, profileId, refresh, gitHubTail,
}: {
  accountLabel: React.ReactNode
  accountTone: string
  accountTitle: string
  status: AccountAuthStatus | undefined
  profileId: string
  refresh: (profileId: string, opts?: { force?: boolean }) => Promise<void>
  gitHubTail: React.ReactNode
}) {
  // Until the FIRST successful read (fetchedAt set) the status is UNKNOWN — the
  // very first render precedes the fetch effect, and a failed first fetch leaves
  // no result either. Never paint "signed out"/"not connected" for unknown: show
  // "…" while pending and "unknown" (error in the tooltip) after a failure.
  const known = status?.fetchedAt !== undefined
  const pending = !known && !status?.error
  const cliOk = status?.cliAuthed === true
  const web = status?.web
  const errorSuffix = status?.error ? ` — could not read status: ${status.error}` : ''
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
        label={accountLabel}
        tone={accountTone}
        title={accountTitle}
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
      {gitHubTail}
    </>
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
  const profiles = useAccountProfilesStore((s) => s.profiles)
  const refresh = useAccountAuthStore((s) => s.refresh)
  const accountAliases = useSettingsStore((s) => s.settings.accountAliases)
  const accountColourOverrides = useSettingsStore((s) => s.settings.accountColourOverrides)
  const theme = useResolvedTheme()
  // Only LOCAL Claude sessions carry per-session Claude Code creds + a claude.ai
  // web session. SSH (remote creds), Codex (not profile-scoped) and shell-only
  // sessions show nothing — same gate the context-menu auth items use.
  const applies = !session.shellOnly && session.sessionType === 'local' && (session.provider ?? 'claude') === 'claude'
  // The Ask help session (#465) keeps ONLY the account pill: it still runs as an
  // account (that requirement predates this), but the claude.ai / Claude Code
  // auth pills and the GitHub pill are workspace chrome a help surface does not
  // carry — and with no auth pills to feed, the status fetch is skipped too.
  const isAsk = session.kind === 'ask'
  const isSshClaude = !session.shellOnly && session.sessionType === 'ssh' && (session.provider ?? 'claude') === 'claude'
  // SSH → local-profile mapping (harmonise-remote): an SSH session delivers its
  // signed-in account via /status (session.accountEmail; fallback the setup-
  // sentinel sshRemoteAccount). When that email matches a LOCAL account profile
  // on THIS machine, the claude.ai web session and the Claude Code sign-in are
  // local-machine actions on that identity, so the SSH header shows the SAME
  // pill set as local, driven by that profile. No match → account-only (there is
  // no local auth to show). session.accountEmail is sanitised at ingest, so this
  // is a plain equality against locally-configured profiles — no new trust.
  // sshMappedProfileId falls back to the session's launch profileId ONLY while
  // no remote email has arrived yet, so the pills resolve the moment a fresh
  // SSH session opens instead of only after a restart. Once the remote reports,
  // the email mapping alone decides (a known non-matching identity stays
  // account-only — never another account's affordances).
  const sshProfileId = isSshClaude ? sshMappedProfileId(session, profiles) : undefined
  const sshProfile = useAccountProfilesStore((s) => (sshProfileId ? s.profiles.find((p) => p.id === sshProfileId) : undefined))
  // Account identity for the SSH pill: the REPORTED remote email when known,
  // else the mapped launch profile's own email — so the top-bar account shows
  // immediately on connect and refines to the remote's reported email when
  // /status lands. `reportedEmail` tracks which of the two is being shown: a
  // locally-sourced stand-in must not be captioned as the remote's sign-in.
  const reportedEmail = isSshClaude ? (session.accountEmail || session.sshRemoteAccount) : undefined
  const remoteEmail = isSshClaude ? (reportedEmail || sshProfile?.accountEmail) : undefined
  // The profile whose auth status feeds the pills: the SSH-mapped local profile
  // for a mapped remote session, else this session's own (or the primary)
  // profile. Undefined for an SSH session with no local match (account-only).
  const profileId = isSshClaude ? sshProfileId : (session.profileId ?? primary?.id)
  const profile = useAccountProfilesStore((s) => (profileId ? s.profiles.find((p) => p.id === profileId) : undefined))
  const status = useAccountAuthStore((s) => (profileId ? s.byProfile[profileId] : undefined))

  React.useEffect(() => {
    // This header renders only the ACTIVE session, so mounting/param-change is
    // "on activate". Fetch for a LOCAL Claude session, and for an SSH session
    // whose remote account maps to a local profile (profileId set). Re-fetch when
    // the session or its (possibly SSH-mapped) account changes.
    if ((applies || isSshClaude) && !isAsk && profileId) void refresh(profileId)
  }, [applies, isSshClaude, isAsk, profileId, refresh, session.id])

  // Never a GitHub pill on the Ask session (#465) — structural, so even a
  // stray githubIntegration on the record (there is no path that sets one,
  // the auto-detect banner is gated) could not paint it.
  const gitHub = isAsk ? null : <SessionGitHubPill session={session} />

  // Phase 3 (harmonise-remote): an SSH Claude session. The ACCOUNT pill is named
  // from its live /status accountEmail (fallback: the setup-sentinel snapshot
  // sshRemoteAccount). When that account maps to a LOCAL profile (sshProfileId,
  // above), the claude.ai / Claude Code pills apply too — those checks are
  // local-profile-scoped and run on THIS machine for the account identity — so
  // the header reads exactly like a local one. With no local match, the pill
  // stands alone (the remote signed-in state is folded into it) and there is no
  // local auth to show. This pill replaces the old mauve remote-account pill.
  if (isSshClaude) {
    const gitHubTail = !isAsk && session.githubIntegration?.repoSlug
      ? (<><div className="w-px h-4 bg-surface1 shrink-0" />{gitHub}</>)
      : null
    // Render the pills whenever we have EITHER a reported/mapped remote email OR
    // a mapped local profile (sshProfileId — the SAME mapping the Artifacts
    // button resolves off). Gating the whole header on remoteEmail left a
    // standard SSH session blank at the top while its Artifacts button worked,
    // because the live remote /status email had not populated session.accountEmail
    // yet even though the launch profile was known. Only a session with neither
    // falls through to just the GitHub pill.
    if (!remoteEmail && !sshProfileId) return gitHubTail
    // Identity to show: the reported/mapped remote email when known, else the
    // mapped profile's own email or name as a first-connect placeholder, so the
    // header paints immediately instead of waiting on the first remote tick.
    const idEmail = remoteEmail || sshProfile?.accountEmail || ''
    const r = idEmail ? resolveAccountNameByEmail(idEmail, profiles, accountAliases) : ''
    const remoteName = idEmail
      ? (r === idEmail ? middleTruncateEmail(idEmail) : r)
      : (sshProfile?.name || 'Account')
    const remoteTone = resolveIdentityColor(
      resolveAccountColourKey(idEmail, accountColourOverrides, session.accountColour ?? sshProfile?.colourKey),
      theme,
    )
    const accountTitle = reportedEmail
      ? `Remote Claude account: ${remoteEmail} (signed in on the remote host)`
      : `Launch account: ${idEmail || remoteName} (the remote host has not reported its signed-in account yet)`
    // Mapped to a local profile → the full local pill set, driven by that
    // profile's auth status. The account pill keeps its remote name/tone/title.
    if (sshProfileId) {
      return (
        <AccountAuthPillSet
          accountLabel={remoteName}
          accountTone={remoteTone}
          accountTitle={accountTitle}
          status={status}
          profileId={sshProfileId}
          refresh={refresh}
          gitHubTail={gitHubTail}
        />
      )
    }
    // No local profile for this account → account pill only.
    return (
      <>
        <HeaderPill
          label={remoteName}
          tone={remoteTone}
          title={accountTitle}
          testId="session-pill-account"
        />
        {gitHubTail}
      </>
    )
  }

  if (!applies || !profileId) {
    // Non-Claude sessions still show the GitHub pill (with its own leading
    // separator) so the right cluster stays consistent.
    return !isAsk && session.githubIntegration?.repoSlug
      ? (<><div className="w-px h-4 bg-surface1 shrink-0" />{gitHub}</>)
      : null
  }

  // Account pill: the Claude account this session ACTUALLY runs as. The LIVE
  // captured identity (session.accountEmail — spawn-time capture from the
  // session's real config dir, refreshed on a mid-session /login) wins over
  // the profile's STORED label: the label is display metadata and can
  // disagree with what is really signed in inside that profile's dir (seen on
  // the WINDOWS_1 staging VM, whose fake-labelled profile carried real
  // credentials — the pill claimed the label while the session ran as the
  // real account). Owner requirement 2026-08-30: whatever account the launch
  // choice actually signed in as appears on top. The profile label remains
  // the fallback until the capture lands, so the pill still paints instantly
  // and daily (label == reality) behaviour is unchanged.
  const email = session.accountEmail || profile?.accountEmail || ''
  // The profile's friendly name applies only while the pill is showing THAT
  // profile's account — never relabel a diverged live account with it.
  const nameHint = profile?.accountEmail && profile.accountEmail === email ? profile?.name : undefined
  const accountName = email
    ? (() => {
        const r = resolveAccountName(email, nameHint, accountAliases)
        return r === email ? middleTruncateEmail(email) : r
      })()
    : (profile?.name || 'Account')
  const accountTone = resolveIdentityColor(
    resolveAccountColourKey(email, accountColourOverrides, session.accountColour ?? profile?.colourKey),
    theme,
  )

  // Slim Ask header (#465): the account pill alone. Everything below this point
  // is auth-status wording for pills the Ask session does not render.
  if (isAsk) {
    return (
      <HeaderPill
        label={accountName}
        tone={accountTone}
        title={email ? `Account: ${email}` : 'This session’s Claude account'}
        testId="session-pill-account"
      />
    )
  }

  // The full account · claude.ai · Claude Code trio, driven by this profile's
  // auth status — the same set an SSH-mapped session renders above (the account
  // pill differs only in its label/tone/title).
  return (
    <AccountAuthPillSet
      accountLabel={accountName}
      accountTone={accountTone}
      accountTitle={email ? `Account: ${email}` : 'This session’s Claude account'}
      status={status}
      profileId={profileId}
      refresh={refresh}
      gitHubTail={<><div className="w-px h-4 bg-surface1 shrink-0" />{gitHub}</>}
    />
  )
}

export default function SessionHeader({ session }: Props) {
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
          {/* One connection pill: kind ("SSH" / "SSH-Persistent") + the remote
              address, styled like the account / GitHub HeaderPills (#291's
              title-bar-style pill system). Replaces the old mauve "SSH: user@host"
              text and the two separate persistence pills. */}
          {/* Phase 6: the container runtime is now the connection pill's KIND,
              not a second pill beside it — teal glyph, no word, the container
              name on hover, and the user@host address kept. The old separate
              `ssh-docker-pill` HeaderPill lived here; its testid rides the
              connection pill's wrapper so nothing that queries it breaks. */}
          <SshConnectionPill session={session} />
          {/* Phase 3 (harmonise-remote): the old mauve remote-account pill
              lived here (item 10, testId ssh-remote-account-pill). Retired —
              SessionAuthPills now renders the ACCOUNT pill for SSH sessions
              from live accountEmail || sshRemoteAccount, same chrome as local. */}
        </span>
      )}

      {/* Right cluster: account · claude.ai · Claude Code | GitHub — styled to
          match the title-bar service pills (GitHub slug shows on hover). */}
      <SessionAuthPills session={session} />
      {/* The encrypted notes left this header for the command bar's Core band
          (ADR-018 D10): one lock with a count, the notes in its popover. */}
    </div>
  )
}
