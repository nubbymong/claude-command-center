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
import { detachedDestinationAgrees, effectiveRuntimeOf, normalizeSshPort } from '../../shared/detached-destination'

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
 *
 * The entry records the session's COMPLETE destination — host, user, port, path
 * and the runtime it actually ran under (#54) — so a later edit of the config it
 * came from can be told apart from the config that launched it.
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
    port: normalizeSshPort(ssh.port),
    runtime: effectiveRuntimeOf(ssh),
    mux: 'tmux',
    accountEmail: session.sshRemoteAccount,
    label: session.customName?.trim() || session.label,
    detachedAt: now,
  }
}

/**
 * Registry entries that could reattach for this config. SSH configs only; a
 * local/non-SSH launch never consults the map. Match by `configId` first (the
 * strong key), and only when nothing matches by config fall back to the
 * destination (host+user+port+path+runtime) so a re-created config pointing at
 * the same remote still finds it. Returns [] for a non-SSH config, an SSH
 * config with no ssh block, or one with no matching remote.
 *
 * #54: the config id is the strong key only while the config still points
 * where the session was left. An entry recorded under this id whose destination
 * has since been edited (host A -> B, another port, a different container) is
 * an ORPHAN of that edit: it is not offered here, its liveness is not asked of
 * the new host (a verified-empty answer from B would have pruned A's entry),
 * and Resume / End never act on B. `detachedDestinationAgrees` is the one rule,
 * shared with main's IPC handlers so the two cannot disagree.
 */
export function matchDetachedRemotes(entries: DetachedRemote[], config: LaunchableConfig): DetachedRemote[] {
  if (config.sessionType !== 'ssh') return []
  const ssh = config.sshConfig
  if (!ssh) return []
  const byConfig = config.id
    ? entries.filter((e) => e.configId === config.id && detachedDestinationAgrees(e, ssh))
    : []
  if (byConfig.length > 0) return byConfig
  return entries.filter((e) => detachedDestinationAgrees(e, ssh))
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
 * The saved config ONE registry entry belongs to, or undefined when its config
 * has been DELETED. The inverse of `matchDetachedRemotes` (which goes
 * config → entries), and deliberately built on the same rule so the two can
 * never disagree: the strong `configId` key first, then the
 * host+username+remotePath fallback for a re-created config pointing at the
 * same remote.
 *
 * `undefined` is a normal, expected answer — the user may delete a config while
 * a remote it launched is still running on the host. The resume surface renders
 * that entry from its own recorded `label` and offers Remove instead of Resume;
 * nothing here may throw on it.
 */
export function configForDetachedEntry<C extends LaunchableConfig>(
  entry: DetachedRemote,
  configs: C[],
): C | undefined {
  // Exact config id wins outright -- while it still points at the recorded
  // destination (#54). matchDetachedRemotes would also accept a DIFFERENT
  // config that merely shares the destination, and resuming into the wrong
  // template (different account, model, post-command) is worse than the
  // deleted-config path. An exact id whose destination moved is NOT the
  // session's config any more; the fallback may still find a re-created one
  // that is, and otherwise the entry is an orphan (see pairDetachedEntry).
  if (entry.configId) {
    const exact = configs.find((c) => c.id === entry.configId)
    if (exact && matchDetachedRemotes([entry], exact).length > 0) return exact
  }
  return configs.find((c) => matchDetachedRemotes([entry], c).length > 0)
}

/**
 * How a registry entry relates to the saved configs, for the resume surface:
 *   - 'paired'      — `config` still reaches the recorded destination; Resume is
 *                     offered through it (the id match, or a re-created config).
 *   - 'retargeted'  — the config it was launched from still exists but was
 *                     EDITED to point elsewhere (host, port, user, path, or
 *                     runtime), and no other config reaches the recorded
 *                     destination. Remove only — never a resume through the
 *                     edited config, which would land on the wrong machine (#54).
 *   - 'deleted'     — no config with its id exists and nothing else reaches the
 *                     destination. Remove only.
 */
export type DetachedEntryPairing<C> =
  | { kind: 'paired'; config: C }
  | { kind: 'retargeted'; config: C }
  | { kind: 'deleted' }

export function pairDetachedEntry<C extends LaunchableConfig>(entry: DetachedRemote, configs: C[]): DetachedEntryPairing<C> {
  const config = configForDetachedEntry(entry, configs)
  if (config) return { kind: 'paired', config }
  const recorded = entry.configId ? configs.find((c) => c.id === entry.configId) : undefined
  if (recorded) return { kind: 'retargeted', config: recorded }
  return { kind: 'deleted' }
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
