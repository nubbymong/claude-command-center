// Transport-badge selection — the ONE truth table every surface reads.
//
// Phase 6 (multi-launch/resume UX round): an SSH row used to carry two
// independent decisions — "SSH or SSH-Persistent?" and, separately, "does a
// container badge COMPOSE on top?" — duplicated in five components. Three of
// them disagreed with each other and with main. The transport is now a single
// THREE-WAY choice made here:
//
//   container   — claude runs one hop deeper, inside a container
//   persistent  — tmux-wrapped; a dropped connection reattaches
//   ssh         — a plain remote session
//   none        — not an SSH row at all
//
// Container WINS over both SSH badges rather than composing with them (owner
// call, signed-off startup mockup: a 16px teal logo-only square, no word).
// Verified against main rather than assumed: pty-manager's SSH spawn sets
// `persistenceEnabled = ssh.detachable !== false && !isContainerSession`, so a
// container session is never tmux-wrapped and could only ever have shown the
// PLAIN "SSH" badge beside the container mark — two chips saying one thing.
// (Note for the record: a container session is therefore NOT "inherently
// persistent" in this build — hop-1 persistence is still pending — but the
// badge rule is the same either way: container wins.)
import type { SshConfig, SshRuntime } from '../../../shared/types'
import { isContainerRuntime, parseDockerPostCommand } from '../../../shared/container-command'

export type TransportBadgeKind = 'none' | 'container' | 'persistent' | 'ssh'

/** The SSH fields any of these surfaces actually has — a saved config's
 *  `sshConfig` and a live session's `sshConfig` are the same shape, and both
 *  reach us off a JSON file, so nothing here trusts a field's declared type. */
export type SshBadgeInput = Partial<Pick<SshConfig, 'runtime' | 'postCommand' | 'dockerContainer' | 'detachable'>>

/**
 * The runtime main would actually use, including the #572 legacy fallback: a
 * free-text `postCommand: 'sudo docker exec -it x bash'` with no structured
 * runtime IS a container session, and main classes it as one. Mirrors
 * `effectiveRuntime` in pty-manager's SSH spawn branch exactly.
 */
export function effectiveSshRuntime(ssh?: SshBadgeInput): SshRuntime | undefined {
  return ssh?.runtime ?? parseDockerPostCommand(ssh?.postCommand ?? '') ?? undefined
}

function legacyContainerName(ssh?: SshBadgeInput): string {
  return typeof ssh?.dockerContainer === 'string' ? ssh.dockerContainer.trim() : ''
}

/**
 * Does this SSH config/session run claude inside a container?
 *
 * The structured `runtime.type === 'container'` (the authority main keys on),
 * the legacy docker-shaped post-command it parses, or the pre-structured
 * `dockerContainer` badge-only hint. A `runtime` block that is present but of
 * an unknown type is NOT a container (main fails that launch closed; a badge
 * must not claim a hop the session never takes).
 */
export function isContainerSsh(ssh?: SshBadgeInput): boolean {
  return isContainerRuntime(effectiveSshRuntime(ssh)) || legacyContainerName(ssh).length > 0
}

/** The container's name for the tooltip, or undefined when only the hop is
 *  known (a container runtime may legitimately carry no name yet). */
export function containerNameOf(ssh?: SshBadgeInput): string | undefined {
  const runtime = effectiveSshRuntime(ssh)
  const structured = isContainerRuntime(runtime) && typeof runtime?.container === 'string' ? runtime.container.trim() : ''
  return structured || legacyContainerName(ssh) || undefined
}

/**
 * The one transport decision, for every surface that shows a transport chip.
 *
 * `persistent` is supplied by the caller because the two families answer it
 * differently and must keep doing so: a SAVED config predicts persistence from
 * its own `detachable !== false` (see `configIsPersistent`), while a LIVE
 * session uses the remote's REPORTED `sshTmuxPersistent === true`. The
 * container branch outranks both, so a caller can pass either safely.
 */
export function resolveTransportBadge(args: {
  isSsh: boolean
  ssh?: SshBadgeInput
  persistent: boolean
}): TransportBadgeKind {
  if (!args.isSsh) return 'none'
  if (isContainerSsh(args.ssh)) return 'container'
  return args.persistent ? 'persistent' : 'ssh'
}

/** A SAVED config's predicted persistence: detachable is opt-OUT, so anything
 *  but an explicit `false` means the tmux ladder will be attempted. */
export function configIsPersistent(ssh?: SshBadgeInput): boolean {
  return ssh?.detachable !== false
}
