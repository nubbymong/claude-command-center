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
const CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
// Same conservative charset the SSH remotePath uses: letters/digits _ . / - ~
const CONTAINER_DIR_RE = /^[A-Za-z0-9_./~-]+$/

export function composeRuntimeCommand(runtime: SshRuntime | undefined): string | undefined {
  if (!runtime || runtime.type !== 'container') return undefined
  const name = (runtime.container ?? '').trim()
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
