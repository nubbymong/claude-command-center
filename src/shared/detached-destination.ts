/**
 * SSH Persistent -- the recorded DESTINATION of a detached remote, and whether a
 * saved config still points at it (#54).
 *
 * A detached entry used to be matched to its config by `configId` alone. Edit
 * that config's host from A to B and every surface followed the id: liveness
 * asked B about A's tmux session (a verified-empty answer then PRUNED A's entry),
 * and Resume / End acted on B. The fallback key (host+user+path) also omitted the
 * port, so two boxes behind one hostname on different ports were one box.
 *
 * The entry now records its complete connection identity -- host, user, port,
 * path, runtime -- and every lookup verifies it: a config-id match whose
 * destination has moved is an ORPHAN of the edit (offer Remove), never a
 * retarget. Renderer and main both apply THIS predicate, so the resume surface
 * and the IPC handlers behind it cannot disagree about what "the same place" is.
 *
 * Pure and shared: no store, no IPC, no node built-ins.
 */
import type { DetachedRemote, SshRuntime } from './types'
import { parseDockerPostCommand } from './container-command'

export const DEFAULT_SSH_PORT = 22

/** The SSH fields a destination is read from -- a saved config's `sshConfig`
 *  and a live session's `sshConfig` are the same shape, and both reach us off a
 *  JSON file, so nothing here trusts a field's declared type. */
export interface SshDestinationSource {
  host: string
  username: string
  port?: number | string
  remotePath?: string
  runtime?: SshRuntime
  postCommand?: string
}

/** The entry fields the destination check reads. */
export type DetachedDestinationEntry = Pick<DetachedRemote, 'host' | 'username' | 'remotePath' | 'port' | 'runtime'>

/** A port as a number, defaulting to 22 for anything that is not a valid TCP
 *  port (absent, a hand-edited string, 0). Mirrors `Number(s.port)` at the
 *  spawn sites, plus the default they get from ssh itself. */
export function normalizeSshPort(port: unknown): number {
  const n = typeof port === 'string' ? Number(port.trim()) : typeof port === 'number' ? port : NaN
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : DEFAULT_SSH_PORT
}

/**
 * The runtime main would actually launch with: the structured block, else the
 * container a legacy free-text docker post-command names (#572), else the host.
 * Always a value, so a NEW entry records `{type:'host'}` explicitly and an
 * ABSENT `runtime` on an entry means "written before #54", not "host".
 */
export function effectiveRuntimeOf(src: Pick<SshDestinationSource, 'runtime' | 'postCommand'> | undefined | null): SshRuntime {
  return src?.runtime ?? parseDockerPostCommand(src?.postCommand ?? '') ?? { type: 'host' }
}

/**
 * What identifies WHERE a runtime puts claude: the host, or a named container on
 * a named engine. `mode`, `sudo` and `containerDir` are how you get in, not where
 * you land -- toggling sudo does not move the session -- so they are not part of
 * the identity. A block of unknown type is not a container (main fails that
 * launch closed) and reads as the host here for the same reason.
 */
export function runtimeIdentityKey(runtime: SshRuntime | undefined | null): string {
  if (!runtime || runtime.type !== 'container') return 'host'
  const engine = runtime.engine === 'podman' ? 'podman' : 'docker'
  const container = typeof runtime.container === 'string' ? runtime.container.trim() : ''
  return `container:${engine}:${container}`
}

function normalizeHost(host: unknown): string {
  // DNS is case-insensitive, and the same box is saved as `Pi.local` in one
  // config and `pi.local` in another (savedSshPingHosts lowercases for the same
  // reason). Whitespace is a hand-edit artefact, never a different host.
  return typeof host === 'string' ? host.trim().toLowerCase() : ''
}

/**
 * Does `ssh` (a saved config's block, as it is NOW) still reach the place
 * `entry` was left running?
 *
 * host (case-insensitive), user and path always compare. port and runtime
 * compare only when the entry RECORDED them: an entry written before #54 has
 * neither, so it is matched on host/user/path exactly as before -- an old
 * registry never turns into a page of orphans on upgrade.
 */
export function detachedDestinationAgrees(
  entry: DetachedDestinationEntry,
  ssh: SshDestinationSource | undefined | null,
): boolean {
  if (!ssh) return false
  // An empty (or non-string) host on either side never agrees: two entries
  // with no host are not the same destination, they are no destination.
  const host = normalizeHost(entry.host)
  if (!host || host !== normalizeHost(ssh.host)) return false
  if (entry.username !== ssh.username) return false
  if (entry.remotePath !== ssh.remotePath) return false
  if (entry.port !== undefined && normalizeSshPort(entry.port) !== normalizeSshPort(ssh.port)) return false
  if (entry.runtime !== undefined && runtimeIdentityKey(entry.runtime) !== runtimeIdentityKey(effectiveRuntimeOf(ssh))) return false
  return true
}

/**
 * Human copy for a destination: `user@host`, `:port` only when it is not 22,
 * ` (container X)` when the session ran inside one. Used by the resume surface
 * to say WHERE a session was left and where its config points now.
 */
export function describeDestination(d: { host: string; username: string; port?: number | string; runtime?: SshRuntime | null }): string {
  const port = normalizeSshPort(d.port)
  let out = `${d.username}@${d.host}${port === DEFAULT_SSH_PORT ? '' : `:${port}`}`
  if (d.runtime?.type === 'container') {
    const name = typeof d.runtime.container === 'string' ? d.runtime.container.trim() : ''
    out += name ? ` (container ${name})` : ' (container)'
  }
  return out
}
