// argv builder for spawning `ssh`/`ssh.exe` for an SSH-backed session. Kept in
// its own module with no electron/node-pty imports so the exact flag list is
// unit-testable without loading pty-manager's native dependencies.

/** Connection target — the subset of SshConfig the argv needs. */
export interface SshArgsTarget {
  username: string
  host: string
  port: number
}

/**
 * Sink-side guard (#265). `username` and `host` are fused into
 * `${username}@${host}` and handed to ssh/ssh.exe as argv[0]. ssh treats any
 * argv entry that begins with `-` as an OPTION, so a value like
 * `-oProxyCommand=...` is an argument-injection primitive (ProxyCommand runs an
 * arbitrary local command). It does not complete on today's builder — consuming
 * argv[0] as an option leaves ssh with no destination, so it usage-errors before
 * connecting — but that safety is accidental: it holds only because argv[0] is
 * the single bare token this builder emits, and any future change adding a
 * second bare token converts it straight into code execution.
 *
 * The IPC boundary already charset-gates these fields, but every argv/shell sink
 * in this codebase re-asserts its own inputs at the point of interpolation (cf.
 * `assertSafeRemotePath` in ssh-shim.ts) so a call site that bypasses the Zod
 * schema cannot rebuild the primitive. Reject a leading `-` and any whitespace;
 * an internal `-` (real hostnames, usernames) is fine, so this is a targeted gate
 * for the argv context, not the full shell-safe allowlist `remotePath` needs.
 */
const SAFE_SSH_FIELD_RE = /^[^-\s]\S*$/

function assertSafeSshField(name: 'username' | 'host', value: string): void {
  if (!SAFE_SSH_FIELD_RE.test(value)) {
    throw new Error(
      `Refusing to build SSH args: ${name} must not be empty, begin with "-", or contain whitespace.`,
    )
  }
}

/**
 * Build the argument list passed to `ssh`/`ssh.exe`.
 *
 * @param ssh      connection target (user, host, port)
 * @param mcpPort  Conductor MCP reverse-tunnel LOCAL target port; when > 0 a
 *                 `-R` forward is added. The host-side target is 127.0.0.1, not
 *                 `localhost`: the MCP server binds IPv4-only, but Windows
 *                 resolves `localhost` IPv6-first (::1) -- a dead address that
 *                 would ECONNREFUSED and kill the channel.
 * @param remoteMcpPort  #24: the REMOTE listen port sshd binds for the `-R`
 *                 forward. Defaults to mcpPort (the pre-#24 shape, where the
 *                 remote and local ports were the same). Passing a distinct
 *                 per-session port lets multiple sessions share ONE host without
 *                 the second colliding on the single fixed port.
 * @param platform host platform (os.platform()). On win32 only, ControlMaster and
 *                 ControlPath are forced off (#241): Windows OpenSSH has no
 *                 connection-multiplexing support, so if the user's global
 *                 ~/.ssh/config enables them ssh.exe errors out before it can
 *                 connect and every CCC SSH session breaks. POSIX ssh multiplexes
 *                 fine, so this stays win32-only and leaves other platforms
 *                 untouched.
 */
export function buildSshArgs(
  ssh: SshArgsTarget,
  mcpPort: number,
  platform: NodeJS.Platform,
  remoteMcpPort: number = mcpPort,
): string[] {
  assertSafeSshField('username', ssh.username)
  assertSafeSshField('host', ssh.host)

  const args = [
    `${ssh.username}@${ssh.host}`,
    '-p', String(ssh.port),
    '-t', // force TTY allocation
    '-o', 'StrictHostKeyChecking=accept-new',
    // #242: tmux persistence only helps if the underlying connection
    // eventually notices it's dead. Laptop sleep, wifi roaming and NAT
    // idle-timeouts can kill a TCP connection while the local socket still
    // looks open, and ssh has no way to detect that without probing.
    // ServerAliveInterval=30 sends an encrypted keepalive every 30s;
    // ServerAliveCountMax=3 gives up after 3 unanswered probes (~90s) so a
    // truly dead connection surfaces (and CCC's reconnect can take over)
    // instead of hanging indefinitely. All platforms — unlike ControlMaster
    // below, keepalive has no Windows-vs-Unix incompatibility.
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
  ]

  if (platform === 'win32') {
    args.push('-o', 'ControlMaster=no', '-o', 'ControlPath=none')
  }

  if (mcpPort > 0) {
    // #24: remote listen port (per session) → the one shared local MCP server.
    const listen = remoteMcpPort > 0 ? remoteMcpPort : mcpPort
    args.push('-R', `${listen}:127.0.0.1:${mcpPort}`)
  }

  return args
}

/**
 * SSH tmux enhancement (item 4): argv for a ONE-SHOT, non-interactive ssh exec
 * that runs `remoteCommand` on the host and exits -- used by endSshRemote
 * (pty-manager.ts) to `tmux kill-session` + remove sidecars over a SEPARATE
 * connection, so the kill never lands in the live Claude pane.
 *
 * Deliberately minimal vs. buildSshArgs: no `-t` (no TTY -- a batch command,
 * not an interactive session), no `-R` MCP tunnel, and BatchMode=yes + a short
 * ConnectTimeout so it FAILS FAST rather than blocking on a password prompt (it
 * relies on key/agent auth; a password-only host simply detaches as before --
 * the remote survives, exactly today's behaviour). `username`/`host` go through
 * the SAME assertSafeSshField argv guard as buildSshArgs, and `remoteCommand`
 * is a host-authored literal with a single sanitized safeSid operand
 * (buildRemoteTmuxKillCommand, ssh-shim.ts) passed to ssh as ONE positional
 * argument, so there is no local shell parse of it.
 *
 * NOTE (see SAFE_SSH_FIELD_RE above): this builder DOES emit a second bare token
 * (`remoteCommand`) after the destination -- the very shape that comment flags
 * as an argument-injection primitive if the destination were option-like. It is
 * safe ONLY because assertSafeSshField rejects a leading-`-` username/host, so
 * the destination can never be consumed as an option and `remoteCommand` can
 * never slide into argv[0]. That guard is now load-bearing here, not merely
 * defence-in-depth -- do not remove it.
 *
 * ControlMaster/ControlPath are forced OFF on ALL platforms (not just win32):
 * this exec is dispatched right before the caller tears down the live PTY (the
 * shared connection's master), so on a POSIX client with `ControlMaster auto`
 * in ~/.ssh/config the exec would otherwise multiplex over that master and be
 * cut off mid-kill when the PTY dies ~400ms later (adversarial review,
 * 2026-08-18). A standalone connection is immune. win32 additionally needs this
 * because Windows OpenSSH has no multiplexing and errors out if config enables
 * it (#241), which is why the flags began win32-only.
 */
export function buildSshExecArgs(ssh: SshArgsTarget, remoteCommand: string, platform: NodeJS.Platform): string[] {
  assertSafeSshField('username', ssh.username)
  assertSafeSshField('host', ssh.host)
  // `platform` retained for signature parity with buildSshArgs / call sites even
  // though the mux flags are now unconditional.
  void platform
  const args = [
    `${ssh.username}@${ssh.host}`,
    '-p', String(ssh.port),
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
  ]
  args.push(remoteCommand)
  return args
}
