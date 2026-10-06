// The environment every Codex setup, sign-in, status and logout subprocess
// runs under (WP2, plan A6; owner decision D3; design 9.2). This allowlist IS
// the security boundary: nothing reaches the child unless it is named here,
// so a credential, endpoint or code-injection variable the app has never
// heard of is excluded by construction rather than by a denylist.
//
// Kept: what the OS, the npm launcher and the CLI need to start and reach
// the network (search path, system and profile directories, temp, locale,
// the user's own proxy and CA settings, and on Linux the desktop session
// for the browser and the keyring). Never kept: every OPENAI_*/CODEX_*
// variable (credentials, endpoints, state roots), NODE_OPTIONS (code
// injection into the npm launcher), RUST_LOG (verbose logs can print
// secrets), BROWSER (an arbitrary command), and everything else.
//
// Always SET, whatever the parent had: CODEX_HOME (the realm, last) and, on
// Windows, NoDefaultCurrentDirectoryInExePath=1 -- npm's codex.cmd runs a
// bare `node`, and without it cmd.exe looks for node in the current folder
// before PATH (the same hardening claude-cli-version.ts applies to the
// Claude shim). The runner must also start the shim from its own folder.
//
// Windows variable names are case-insensitive, so there matching and
// de-duplication are case-insensitive and the first spelling seen is kept;
// POSIX names are case-sensitive and matched exactly. The result has no
// prototype: Node's spawn walks inherited keys, so a polluted
// Object.prototype must have nothing to contribute.

const ALLOWED: ReadonlySet<string> = new Set([
  // search path and executable resolution
  'PATH', 'PATHEXT',
  // Windows system and profile directories the CLI and npm launcher read
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'COMMONPROGRAMFILES', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME',
  // POSIX identity and home
  'HOME', 'USER', 'LOGNAME',
  // temp and locale
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ',
  // the user's own network configuration (POSIX tools mostly read the
  // lower-case spelling, and names are case-sensitive there)
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  // Linux desktop session: opening the sign-in page and the secret service keyring
  'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_CURRENT_DESKTOP', 'DBUS_SESSION_BUS_ADDRESS',
])

/** Only plain variable names: no Unicode case-folding tricks (a long s or a
 *  dotless i upper-cases onto an ASCII name). */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_()]*$/

/** Values with a meaning beyond "a string": a D-Bus address can name a
 *  transport that RUNS a program (unixexec:, autolaunch:) or a remote bus
 *  (tcp:), and the runtime directory must be an absolute path. */
function valueAllowed(key: string, value: string): boolean {
  if (key === 'DBUS_SESSION_BUS_ADDRESS') return value.split(';').every((a) => /^unix:(path|abstract)=[^,;]+(,[a-z]+=[^,;]*)*$/.test(a))
  if (key === 'XDG_RUNTIME_DIR') return value.startsWith('/')
  return true
}

/** A clean environment for one Codex CLI operation in one realm. */
export function codexCliEnv(
  inherited: Readonly<Record<string, string | undefined>>,
  codexHome: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  if (typeof codexHome !== 'string' || !codexHome) throw new Error('a Codex CLI operation needs its realm home')
  const win = platform === 'win32'
  const out: Record<string, string> = Object.create(null) as Record<string, string>
  const seen = new Set<string>()
  for (const name of Object.keys(inherited)) {
    const value = inherited[name]
    if (typeof value !== 'string' || !NAME_RE.test(name)) continue
    const key = win ? name.toUpperCase() : name
    if (!ALLOWED.has(key) || seen.has(key) || !valueAllowed(key, value)) continue
    seen.add(key)
    out[name] = value
  }
  if (win) out.NoDefaultCurrentDirectoryInExePath = '1'
  out.CODEX_HOME = codexHome
  return out
}

/** The allowlist, for diagnostics and tests. */
export function codexCliEnvAllowlist(): readonly string[] {
  return [...ALLOWED]
}
