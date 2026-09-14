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
 *   exec  (default): [sudo] <engine> exec -it [-w <dir>] <name> <shell>
 *   start          : [sudo] <engine> start -ai <name>
 *
 * The ENTRY command the SSH flow actually types (rc.15 review R1,
 * aicc_planning#45) is `composeContainerEntryCommand` below: the same exec
 * shape, wrapped so that a process INSIDE the container announces the entry
 * with a per-attempt nonce sentinel. `composeRuntimeCommand` stays the plain,
 * sentinel-free shape -- it validates the runtime at spawn; the detached
 * destination and badge code read the parsed runtime, never the wrapper.
 */

// Docker/podman container-name charset (both engines enforce this on create).
// Exported because the End path revalidates the SAME name independently before
// interpolating it into the in-container kill command (buildContainerKillCommand,
// ssh-shim.ts) — a second boundary, but deliberately not a second COPY of the
// charset, which could drift from this one.
export const CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
// Same conservative charset the SSH remotePath uses: letters/digits _ . / - ~
const CONTAINER_DIR_RE = /^[A-Za-z0-9_./~-]+$/
// The entry nonce is interpolated into a shell line (inside single quotes, as a
// printf ARGUMENT and an env-var VALUE). randomId() is lowercase hex; anything
// else is refused rather than quoted, so no quoting rule ever has to be right.
const ENTRY_NONCE_RE = /^[a-z0-9]{8,64}$/

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
 * Does this runtime put claude one hop deeper, inside a container?
 *
 * The single predicate every container-conditional decision keys on (the tmux
 * persistence gate and the End container-kill), so a runtime that reached the
 * app from a legacy free-text post-command is classed the same way a structured
 * one is. See `effectiveRuntime` in pty-manager's SSH spawn branch.
 */
export function isContainerRuntime(runtime: SshRuntime | undefined): boolean {
  return runtime?.type === 'container'
}

/**
 * Can this runtime's entry be PROVEN target-bound (rc.15 review R1)? Only an
 * `exec` into a named container can: the app composes the exec so a process
 * inside that container prints the entry sentinel. `start -ai` attaches the
 * container's ENTRYPOINT, which need not be a shell at all, so nothing can be
 * typed into it to prove where it landed -- such entries are never promoted to
 * "inner" without the user's explicit consent (see the SSH flow overlay).
 */
export function isProvableContainerEntry(runtime: SshRuntime | undefined): boolean {
  return isContainerRuntime(runtime) && runtime?.mode !== 'start'
}

/**
 * Runtime types this build understands. A `runtime` block that is PRESENT but
 * carries anything else is a corrupt or hand-edited config, not a host session.
 */
const KNOWN_RUNTIME_TYPES: ReadonlySet<string> = new Set(['host', 'container'])

/** The validated parts of a container runtime, shared by both composers. */
function validatedContainerParts(runtime: SshRuntime): { sudo: string; engine: string; name: string; wFlag: string; shell: 'bash' | 'sh' } {
  const name = readContainerName(runtime)
  if (!name) throw new Error('container runtime selected but no container name configured')
  if (!CONTAINER_NAME_RE.test(name)) throw new Error(`unsafe container name: ${JSON.stringify(name)}`)
  const engine = runtime.engine === 'podman' ? 'podman' : 'docker'
  const sudo = runtime.sudo ? 'sudo ' : ''
  const dir = typeof runtime.containerDir === 'string' ? runtime.containerDir.trim() : ''
  if (dir && !CONTAINER_DIR_RE.test(dir)) throw new Error(`unsafe container directory: ${JSON.stringify(dir)}`)
  const wFlag = dir ? `-w ${dir} ` : ''
  // The shell is a two-literal pick, never an interpolated value: a legacy
  // `... sh` line keeps sh (a sh-only container must not be handed `bash`,
  // Codex rc.16 plan review, condition 2); everything else is bash, as the
  // structured runtime has always composed.
  const shell: 'bash' | 'sh' = runtime.shell === 'sh' ? 'sh' : 'bash'
  return { sudo, engine, name, wFlag, shell }
}

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
  const { sudo, engine, name, wFlag, shell } = validatedContainerParts(runtime)
  if (runtime.mode === 'start') return `${sudo}${engine} start -ai ${name}`
  return `${sudo}${engine} exec -it ${wFlag}${name} ${shell}`
}

/** The entry sentinel a process inside the container prints: `__CCC_<nonce>_IN__`
 *  before the shell starts, `__CCC_<nonce>_OUT__` after it exits, and
 *  `__CCC_<nonce>_HERE__` in answer to the launch-time guard. */
export type EntrySentinelWord = 'IN' | 'OUT' | 'HERE'

export function entrySentinel(nonce: string, word: EntrySentinelWord): string {
  return `__CCC_${nonce}_${word}__`
}

/**
 * The command the SSH flow TYPES to enter a container (rc.15 review R1 --
 * "cancelled container entry can still launch claude on the host"). Prompt
 * shape and silence never prove an entry; only this sentinel does:
 *
 *   [sudo] <engine> exec -it [-w <dir>] <name> sh -c 'printf "__CCC_%s_%s__\n" <nonce> IN; CCC_ENTRY=<nonce> <shell>; printf "__CCC_%s_%s__\n" <nonce> OUT'
 *
 *  - `printf ... IN` runs INSIDE the named container (the engine put it there),
 *    so the joined `__CCC_<nonce>_IN__` line is target-bound. The format string
 *    and the arguments are separate words: the host's echo of the typed line
 *    never contains the joined token, and neither can a static banner/MOTD.
 *  - The outer shell is `sh -c` on purpose: a non-interactive POSIX sh (bash
 *    invoked as sh, dash, busybox ash, mksh) reads NO startup file, so nothing
 *    of the container's runs before IN is printed -- a `[sudo]` prompt in a
 *    container rc file can only appear AFTER the flow already knows it is
 *    inside, where the host sudo secret is refused. `bash -c` would read
 *    BASH_ENV first (Codex rc.16 plan review, condition 4).
 *  - The user's shell is a CHILD, not `exec`'d, so when it exits (an `exit` in
 *    an rc file, the user leaving) the wrapper prints OUT and the flow fails
 *    closed instead of keeping "inner" latched over a host prompt.
 *  - CCC_ENTRY=<nonce> is inherited by the interactive shell and everything it
 *    runs. The launch-time guard (buildEntryGuardCommand) reads it back: only a
 *    shell descended from THIS attempt's exec answers with the current nonce; a
 *    host shell (detach keys, a stopped container) answers with nothing.
 *  Per-ATTEMPT nonce (Run again mints a new one) so a delayed IN from an
 *  earlier attempt can never promote a later one. Same trust boundary as every
 *  other sentinel in the flow: an actor that can read the TTY (or, inside the
 *  container, the shell's environment -- CCC_ENTRY is inherited by claude and
 *  every child) can copy the nonce and forge an answer.
 *
 * Returns undefined for a host runtime; the plain `start -ai` line for start
 * mode (no sentinel is possible there -- see isProvableContainerEntry).
 */
export function composeContainerEntryCommand(runtime: SshRuntime | undefined, nonce: string): string | undefined {
  const plain = composeRuntimeCommand(runtime)
  if (plain === undefined || !runtime) return plain
  if (!ENTRY_NONCE_RE.test(nonce)) throw new Error('unsafe container entry nonce')
  if (runtime.mode === 'start') return plain
  const { sudo, engine, name, wFlag, shell } = validatedContainerParts(runtime)
  const mark = (word: EntrySentinelWord) => `printf "__CCC_%s_%s__\\n" ${nonce} ${word}`
  return `${sudo}${engine} exec -it ${wFlag}${name} sh -c '${mark('IN')}; CCC_ENTRY=${nonce} ${shell}; ${mark('OUT')}'`
}

/**
 * The launch-time guard the flow types into the shell it BELIEVES is the
 * container, before any ordinary launch write: the shell expands CCC_ENTRY
 * itself, so the answer `__CCC_<nonce>_HERE__` proves the attached shell
 * descends from this attempt's exec. POSIX sh, bash, zsh and fish all expand
 * `"$VAR"` inside double quotes and have a printf; a host shell prints
 * `__CCC__HERE__`, which no nonce matches.
 */
export function buildEntryGuardCommand(): string {
  return `printf '__CCC_%s_%s__\\n' "$CCC_ENTRY" HERE`
}

/**
 * Every entry sentinel in `text` carrying THIS nonce, in the order they
 * appear. Each must be followed by a line terminator (the chunk-boundary
 * discipline every other sentinel parser in the flow uses): a sentinel whose
 * `__` closer has not arrived yet is not a sentinel. `text` is expected to be
 * the ANSI-stripped, line-buffered post-command output, so a ConPTY escape
 * glued into the token cannot break it.
 */
export function parseEntrySentinels(text: string, nonce: string): EntrySentinelWord[] {
  if (!ENTRY_NONCE_RE.test(nonce)) return []
  const re = new RegExp(`__CCC_${nonce}_(IN|OUT|HERE)__(?=[\\r\\n])`, 'g')
  const found: EntrySentinelWord[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) found.push(m[1] as EntrySentinelWord)
  return found
}

/**
 * Detect a docker-shaped free-text post-command (the pre-redesign way of
 * entering a container) so the dialog can offer a one-click convert, and so
 * the SSH flow can class the session as a container session (#572) and enter
 * it through the proven wrapper above (rc.15 review R1). Nothing is converted
 * silently in the dialog — this only powers the affordance.
 *
 * Recognised: `[sudo] (docker|podman) exec <flags> <name> (bash|sh|/bin/bash|/bin/sh)`
 * where the flags are `-it`/`-ti`/`-i -t`/`-t -i` with an optional `-w <dir>`
 * in any position (Codex rc.16 plan review: `sudo docker exec -it -w /work
 * review sh` used to miss the parse, so the session was classed as a plain
 * host and got no entry watch at all). Both -i and -t are required: an exec
 * without a TTY is not an interactive entry.
 */
export function parseDockerPostCommand(postCommand: string): SshRuntime | null {
  // Tolerate a non-string: postCommand can arrive from a hand-edited config
  // file (bindSshToSavedConfig copies it untyped), and a `.trim()` TypeError
  // here would throw out of spawnPty rather than reading as "no docker shape".
  if (typeof postCommand !== 'string') return null
  const m = postCommand.trim().match(
    /^(sudo\s+)?(docker|podman)\s+exec((?:\s+(?:-it|-ti|-i|-t|-w\s+[A-Za-z0-9_./~-]+))+)\s+([A-Za-z0-9][A-Za-z0-9_.-]*)\s+(bash|sh|\/bin\/bash|\/bin\/sh)$/
  )
  if (!m) return null
  const flags = m[3].trim().split(/\s+/)
  let interactive = false
  let tty = false
  let containerDir: string | undefined
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]
    if (f === '-it' || f === '-ti') { interactive = true; tty = true }
    else if (f === '-i') interactive = true
    else if (f === '-t') tty = true
    else if (f === '-w') {
      if (containerDir !== undefined) return null // two -w flags: not a shape we compose
      containerDir = flags[++i]
    }
  }
  if (!interactive || !tty) return null
  const shell = m[5].endsWith('sh') && !m[5].endsWith('bash') ? 'sh' : 'bash'
  return {
    type: 'container',
    engine: m[2] as 'docker' | 'podman',
    container: m[4],
    mode: 'exec',
    sudo: Boolean(m[1]),
    ...(containerDir !== undefined ? { containerDir } : {}),
    // bash is the default the structured runtime composes; only the deviation
    // is recorded, so a legacy `... bash` line derives the same runtime shape
    // it always did (the End kill path stores this object).
    ...(shell === 'sh' ? { shell: 'sh' as const } : {}),
  }
}
