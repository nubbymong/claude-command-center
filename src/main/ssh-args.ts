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
 * @param mcpPort  Conductor MCP reverse-tunnel port; when > 0 a `-R` forward is
 *                 added. The host-side target is 127.0.0.1, not `localhost`: the
 *                 MCP server binds IPv4-only, but Windows resolves `localhost`
 *                 IPv6-first (::1) -- a dead address that would ECONNREFUSED and
 *                 kill the channel.
 * @param platform host platform (os.platform()). On win32 only, ControlMaster and
 *                 ControlPath are forced off (#241): Windows OpenSSH has no
 *                 connection-multiplexing support, so if the user's global
 *                 ~/.ssh/config enables them ssh.exe errors out before it can
 *                 connect and every CCC SSH session breaks. POSIX ssh multiplexes
 *                 fine, so this stays win32-only and leaves other platforms
 *                 untouched.
 */
export function buildSshArgs(ssh: SshArgsTarget, mcpPort: number, platform: NodeJS.Platform): string[] {
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
    args.push('-R', `${mcpPort}:127.0.0.1:${mcpPort}`)
  }

  return args
}
