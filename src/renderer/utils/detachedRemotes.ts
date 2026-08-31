/**
 * SSH Persistent — "Resume a Running Session".
 *
 * Pure, store-free helpers for the detached-remote registry: build an entry from
 * a live session, match the registry against a config being launched, and filter
 * out anything that is already live. Kept out of the store (and out of React) so
 * the match/filter/age logic is unit-testable in isolation — no zustand, no
 * window, no IPC. See detachedRemotesStore.ts for the stateful side.
 */
import type { DetachedRemote } from '../../shared/types'
import type { Session } from '../stores/sessionStore'
import type { TerminalConfig } from '../stores/configStore'

/** The Session fields buildDetachedRemote reads — a narrow view so this module
 *  never depends on the full store record. */
export type DetachableSession = Pick<
  Session,
  'id' | 'configId' | 'sessionType' | 'sshConfig' | 'sshRemoteAccount' | 'customName' | 'label'
>

/** The TerminalConfig fields the match logic reads. */
export type LaunchableConfig = Pick<TerminalConfig, 'id' | 'sessionType' | 'sshConfig'>

/**
 * Build a registry entry from a session being LEFT RUNNING, or null when the
 * session is not an eligible remote (not SSH, or missing its ssh config). The
 * multiplexer is always 'tmux' for now — psmux (Windows) is not wired yet, so
 * the field is recorded as 'tmux' regardless of remoteOs (a Windows remote's
 * reattach is a known upstream gap and degrades to a fresh create either way).
 */
export function buildDetachedRemote(session: DetachableSession | undefined | null, now: number): DetachedRemote | null {
  if (!session) return null
  if (session.sessionType !== 'ssh') return null
  const ssh = session.sshConfig
  if (!ssh) return null
  return {
    sessionId: session.id,
    configId: session.configId,
    host: ssh.host,
    username: ssh.username,
    remotePath: ssh.remotePath,
    mux: 'tmux',
    accountEmail: session.sshRemoteAccount,
    label: session.customName?.trim() || session.label,
    detachedAt: now,
  }
}

/**
 * Registry entries that could reattach for this config. SSH configs only; a
 * local/non-SSH launch never consults the map. Match by `configId` first (the
 * strong key), and only when nothing matches by config fall back to
 * host+username+remotePath so a re-created config pointing at the same remote
 * still finds it. Returns [] for a non-SSH config or an SSH config with no
 * matching remote.
 */
export function matchDetachedRemotes(entries: DetachedRemote[], config: LaunchableConfig): DetachedRemote[] {
  if (config.sessionType !== 'ssh') return []
  const byConfig = config.id ? entries.filter((e) => e.configId === config.id) : []
  if (byConfig.length > 0) return byConfig
  const ssh = config.sshConfig
  if (!ssh) return []
  return entries.filter(
    (e) => e.host === ssh.host && e.username === ssh.username && e.remotePath === ssh.remotePath,
  )
}

/**
 * Drop any entry whose session id is CURRENTLY live (already open, or just
 * restored on app relaunch). Reusing a live id would collide with a running
 * tile — the whole reason the resume is safe is that the old tile was removed on
 * Leave running, so an entry that is somehow still live must never be offered.
 */
export function filterLiveEntries(entries: DetachedRemote[], liveSessionIds: Iterable<string>): DetachedRemote[] {
  const live = liveSessionIds instanceof Set ? liveSessionIds : new Set(liveSessionIds)
  return entries.filter((e) => !live.has(e.sessionId))
}

/**
 * The reattach candidates to OFFER for a config on the resume surface: matched by
 * config and not currently live. `[]` means this config has nothing to resume.
 * NOT consulted by the launch path — a config launch always starts new.
 */
export function resumableRemotesForConfig(
  entries: DetachedRemote[],
  config: LaunchableConfig,
  liveSessionIds: Iterable<string>,
): DetachedRemote[] {
  return filterLiveEntries(matchDetachedRemotes(entries, config), liveSessionIds)
}

/**
 * Compact "left running Xm ago" phrasing for the resume surface. Pure (takes
 * `now`) so it is testable and never surprises the render with a moving clock.
 */
export function describeDetachedAge(detachedAt: number, now: number): string {
  const ms = Math.max(0, now - detachedAt)
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
