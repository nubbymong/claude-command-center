// src/renderer/utils/sessionLaunch.ts
//
// Small pure helpers for the session-launch path in TerminalView, extracted so
// the launch decisions are unit-testable (TerminalView itself is xterm-bound).
import type { ProviderId } from '../../shared/types'

/** How the partner terminal's strip names the assistant of the session it
 *  sits beside: beside a Codex session it reads "not Codex", with the way
 *  "Back to Codex". A session with no provider is Claude, and a Claude
 *  session reads as it always has. */
export function sessionAgentName(provider?: ProviderId): string {
  return provider === 'codex' ? 'Codex' : 'Claude'
}

/**
 * Whether a session launch should pop the multi-account picker
 * (AccountLaunchGate) before spawning.
 *
 * This picker is the CLAUDE profile picker: each Claude account gets a
 * private `~/.claude` home via `withProfileHome`. A Codex session runs on the
 * Codex account its config names (or the Codex default), each in its own
 * Codex home, resolved at launch by utils/launchAccount.ts, and an SSH
 * session runs under the REMOTE host's own login, so neither must ever show
 * the Claude account picker.
 * The old gate checked only `shellOnly` + a session record + `profileCount >= 2`
 * and so fired for Codex (BUG-1) and SSH (BUG-13) sessions whenever a second
 * Claude account profile existed. Provider- + SSH-gating fixes that.
 */
export function shouldGateAccountChoice(opts: {
  shellOnly?: boolean
  hasSession: boolean
  profileCount: number
  provider?: ProviderId
  isSsh?: boolean
}): boolean {
  const provider = opts.provider ?? 'claude'
  return !opts.shellOnly && opts.hasSession && opts.profileCount >= 2 && provider === 'claude' && !opts.isSsh
}

/**
 * Whether the mid-session "Switch Account" control applies to a session (the
 * Sidebar context menu + the SessionStatusStrip pill). Same rule as the launch
 * gate minus the launch-only conditions: a LOCAL session with a real choice of
 * its own provider's accounts. Claude's are its local profiles, so an SSH
 * session (the remote host's login) never switches one (BUG-13). P3.6 (row
 * 22): a Codex session switches among the Codex accounts (its registry
 * accounts, archived ones left out: `providerAccountCount`), also local only
 * in this release; Claude's profiles never count for it.
 */
export function canSwitchAccountForSession(opts: {
  provider?: ProviderId
  isSsh?: boolean
  profileCount: number
  /** How many accounts a Switch account would list for a session of a
   *  provider other than Claude Code (utils/switchAccountItems). */
  providerAccountCount?: number
  /** Shell-only panes (incl. the add-account /login shell, which is pinned to
   *  a brand-new profile) must never offer Switch Account: respawning the
   *  login shell under another profile redirects the /login into that
   *  account's private home (same class as BUG-1/BUG-13). */
  shellOnly?: boolean
}): boolean {
  const provider = opts.provider ?? 'claude'
  if (opts.shellOnly || opts.isSsh) return false
  if (provider !== 'claude') return (opts.providerAccountCount ?? 0) >= 2
  // macOS: Claude Code keeps its live OAuth token in the login Keychain,
  // which per-profile HOME redirection cannot isolate — switching would
  // relabel the session while every API call kept using the shared token
  // (Mac readiness review 2026-07-02, confirmed blocker). Multi-account is
  // Windows-only until a darwin Keychain-swap engine exists. (This rule is
  // Claude Code's; a Codex session switches as it launches, in the account's
  // own folder.)
  if (typeof window !== 'undefined' && window.electronPlatform === 'darwin') return false
  return opts.profileCount >= 2
}

/**
 * The local account profile whose email matches an SSH session's signed-in
 * REMOTE account, or undefined.
 *
 * An SSH session runs `claude` on another host but delivers that host's
 * signed-in account to the app via its /status POST (`accountEmail`; the
 * setup-sentinel `sshRemoteAccount` snapshot is the fallback). When that email
 * matches a LOCAL account profile on THIS machine, the account's local-machine
 * affordances — the claude.ai web session, the Claude Code sign-in, Open
 * artifacts — apply to the remote session too: they act on the account IDENTITY,
 * which is the same identity locally (harmonise-remote), so remote-ness alone
 * does not preclude them. This resolves that mapping.
 *
 * Returns undefined for a local / shell-only / non-Claude session, or an SSH
 * session whose remote account has no matching local profile. Account SWITCHING
 * stays disabled for SSH regardless (see canSwitchAccountForSession) — switching
 * respawns under a different LOCAL profile, which cannot change the remote's.
 */
export function sshMappedProfileId(
  session: {
    shellOnly?: boolean
    sessionType?: string
    provider?: ProviderId
    accountEmail?: string
    sshRemoteAccount?: string
    profileId?: string
  },
  profiles: ReadonlyArray<{ id: string; accountEmail?: string }>,
): string | undefined {
  if (session.shellOnly || session.sessionType !== 'ssh' || (session.provider ?? 'claude') !== 'claude') return undefined
  // The live remote account (from /status; fallback the setup-sentinel
  // snapshot) is the authority: once an email is known, ONLY an email match
  // maps — a known remote identity that matches no local profile stays
  // unmapped (account-only pills), never silently replaced by some other
  // local account's affordances.
  //
  // Only while NO remote identity has arrived yet (the instant between a
  // fresh connect and the first status tick — first-connect priming makes
  // this short) does the session's own launch `profileId` stand in, so the
  // pills resolve immediately instead of blank. In the normal same-identity
  // case that is the SAME account; when /status lands the email mapping
  // takes over (and corrects it if not).
  const email = session.accountEmail || session.sshRemoteAccount
  if (email) return profiles.find((p) => p.accountEmail === email)?.id
  return session.profileId && profiles.some((p) => p.id === session.profileId) ? session.profileId : undefined
}

/**
 * How a RESUMED session (an app-relaunch restore) chooses its account (#446).
 *   - 'auto-last' (default): continue silently under the account the session
 *     ran under — restored sessions are marked predetermined, no gate.
 *   - 'ask': the account picker opens per restored session (pre-selecting the
 *     last account), by NOT marking it predetermined.
 * Absent or unrecognised => 'auto-last', so no existing install changes on
 * upgrade. Resolver-based default (the settings enum convention here), not a
 * DEFAULT_SETTINGS entry.
 */
export function resolveResumeAccountMode(value: unknown): 'ask' | 'auto-last' {
  return value === 'ask' ? 'ask' : 'auto-last'
}

/**
 * Whether an app-relaunch restore should mark its sessions predetermined —
 * i.e. continue silently under the saved account (#446). True in 'auto-last'
 * (the default), false in 'ask' (let the gate open per restored session).
 * Extracted so the App restore branch is pinned by a unit test rather than
 * living only in App.tsx (which is not unit-testable).
 */
export function shouldPredetermineRestoredAccount(resumeAccountMode: unknown): boolean {
  return resolveResumeAccountMode(resumeAccountMode) === 'auto-last'
}

/**
 * Render a PTY-spawn failure into a readable, single-line terminal message.
 *
 * The renderer used to fire `pty.spawn` without catching, so a main-process
 * throw (e.g. "Codex CLI not found on PATH") became a silent unhandled
 * rejection and a blank terminal (BUG-2). We now surface it in the terminal;
 * this strips the IPC `invoke` wrapper noise so the user sees the real cause.
 */
export function formatSpawnError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? 'unknown error')
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']*':\s*/i, '')
    .replace(/^(Uncaught )?Error:\s*/i, '')
    .trim()
  return cleaned || 'unknown error'
}
