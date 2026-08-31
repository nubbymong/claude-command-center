import type { SshRuntime } from './types'

/**
 * Compose the container command for a structured SshRuntime (config-modal
 * redesign, item e). The app builds this string itself — the point of the
 * structured field is that the container hop stops being an opaque user
 * command — so every interpolated part is validated here as defence in depth
 * (the values also travel the IPC schema): a name or path that could break
 * out of the argv shape is rejected and the session fails loudly instead of
 * writing a mangled command into the remote shell.
 *
 * Shapes:
 *   exec  (default): [sudo] <engine> exec -it [-w <dir>] <name> bash
 *   start          : [sudo] <engine> start -ai <name>
 */

// Docker/podman container-name charset (both engines enforce this on create).
// Exported because the End path revalidates the SAME name independently before
// interpolating it into the in-container kill command (buildContainerKillCommand,
// ssh-shim.ts) — a second boundary, but deliberately not a second COPY of the
// charset, which could drift from this one.
export const CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
// Same conservative charset the SSH remotePath uses: letters/digits _ . / - ~
const CONTAINER_DIR_RE = /^[A-Za-z0-9_./~-]+$/

/**
 * Read `runtime.container` as a string, or `undefined` when it is absent.
 *
 * Adversarial review (ADR-009): the field is typed `string | undefined` but the
 * value is loaded from a JSON config file and, on the no-configId spawn branch,
 * arrives straight off the IPC request — neither of which the type system
 * checks. `(runtime.container ?? '').trim()` throws a TypeError on a number or
 * an array, and one of the two call sites (buildContainerKillCommand, reached
 * from endSshRemote OUTSIDE the executor try) would have turned that throw into
 * a skipped cleanup of EVERYTHING — container, tmux and sidecars alike. A
 * non-string is now simply "no name", which both call sites already reject.
 */
export function readContainerName(runtime: SshRuntime): string {
  return typeof runtime.container === 'string' ? runtime.container.trim() : ''
}

/**
 * Runtime types this build understands. A `runtime` block that is PRESENT but
 * carries anything else is a corrupt or hand-edited config, not a host session.
 */
const KNOWN_RUNTIME_TYPES: ReadonlySet<string> = new Set(['host', 'container'])

export function composeRuntimeCommand(runtime: SshRuntime | undefined): string | undefined {
  // No runtime block at all = a plain host session (the pre-redesign default).
  if (!runtime) return undefined
  // Adversarial review (ADR-009): an unrecognised `type` used to fall through
  // this function's `!== 'container'` test and return undefined — i.e. a config
  // whose Runtime block says `'Container'` or `'containr'` launched claude on
  // the BARE HOST, silently, with no container hop and no error. config:save
  // does no schema validation, so a typo (or a config edited by hand, or written
  // by an older/newer build) reached this sink verbatim. Fail closed instead:
  // throwing joins the `runtimeInvalid` latch in pty-manager, which refuses
  // every launch path for the session rather than degrading to the host — the
  // same posture the validated-but-unsafe container name already had.
  if (!KNOWN_RUNTIME_TYPES.has(runtime.type as string)) {
    throw new Error(`unknown ssh runtime type: ${JSON.stringify(runtime.type)}`)
  }
  if (runtime.type !== 'container') return undefined
  const name = readContainerName(runtime)
  if (!name) throw new Error('container runtime selected but no container name configured')
  if (!CONTAINER_NAME_RE.test(name)) throw new Error(`unsafe container name: ${JSON.stringify(name)}`)
  const engine = runtime.engine === 'podman' ? 'podman' : 'docker'
  const sudo = runtime.sudo ? 'sudo ' : ''
  if (runtime.mode === 'start') return `${sudo}${engine} start -ai ${name}`
  const dir = (runtime.containerDir ?? '').trim()
  if (dir && !CONTAINER_DIR_RE.test(dir)) throw new Error(`unsafe container directory: ${JSON.stringify(dir)}`)
  const wFlag = dir ? `-w ${dir} ` : ''
  return `${sudo}${engine} exec -it ${wFlag}${name} bash`
}

/**
 * Detect a docker-shaped free-text post-command (the pre-redesign way of
 * entering a container) so the dialog can offer a one-click convert. Nothing
 * is converted silently — this only powers the affordance.
 */
export function parseDockerPostCommand(postCommand: string): SshRuntime | null {
  const m = postCommand.trim().match(
    /^(sudo\s+)?(docker|podman)\s+exec\s+(?:-it|-ti|-i\s+-t)\s+([A-Za-z0-9][A-Za-z0-9_.-]*)\s+(?:bash|sh|\/bin\/bash|\/bin\/sh)$/
  )
  if (!m) return null
  return {
    type: 'container',
    engine: m[2] as 'docker' | 'podman',
    container: m[3],
    mode: 'exec',
    sudo: Boolean(m[1]),
  }
}
