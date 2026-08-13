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
  const args = [
    `${ssh.username}@${ssh.host}`,
    '-p', String(ssh.port),
    '-t', // force TTY allocation
    '-o', 'StrictHostKeyChecking=accept-new',
  ]

  if (platform === 'win32') {
    args.push('-o', 'ControlMaster=no', '-o', 'ControlPath=none')
  }

  if (mcpPort > 0) {
    args.push('-R', `${mcpPort}:127.0.0.1:${mcpPort}`)
  }

  return args
}
