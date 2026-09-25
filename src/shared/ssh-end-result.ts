import type { SshEndRemoteResult } from './types'
import { CONTAINER_NAME_RE } from './container-command'

/** A host as the End notice shows it: one printable ASCII token, not an option. */
const HOST_DISPLAY_RE = /^[!-~]{1,255}$/

/**
 * The `ssh:endRemote` result as the renderer may use it, or null.
 *
 * Main builds the result from its own state (the session's connection and the
 * container name it validated before building the kill). The renderer checks
 * the shape again before anything is shown or turned into a command: the
 * outcome must be one of the four, and for 'container-needs-sudo' the engine
 * must be one of the two literals and the name must pass CONTAINER_NAME_RE.
 * Anything else reads as no result, so a malformed value never reaches the
 * End notice.
 *
 * The host is only ever SHOWN: the stop command is built from the engine, the
 * name and the session id, never from the host. So a host the notice cannot
 * show as one printable ASCII token that does not begin with `-` (an IDN or
 * other non-ASCII name, a zero-width character, more than 255 characters, all
 * of which the spawn schema accepts) does not drop the notice: the result
 * comes back without it, and the notice says "the SSH host" instead.
 */
export function readSshEndRemoteResult(v: unknown): SshEndRemoteResult | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  const outcome = r.outcome
  if (outcome === 'completed' || outcome === 'failed' || outcome === 'no-target') return { outcome }
  if (outcome !== 'container-needs-sudo') return null
  const c = r.container
  if (typeof c !== 'object' || c === null || Array.isArray(c)) return null
  const { engine, name, host } = c as Record<string, unknown>
  if (engine !== 'docker' && engine !== 'podman') return null
  if (typeof name !== 'string' || !CONTAINER_NAME_RE.test(name)) return null
  const showable = typeof host === 'string' && HOST_DISPLAY_RE.test(host) && !host.startsWith('-')
  return { outcome, container: showable ? { engine, name, host } : { engine, name } }
}
