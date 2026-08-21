/**
 * The host's light/dark scheme, and how a launched session is told about it.
 *
 * Claude Code reads COLORFGBG FIRST when auto-detecting its theme; without it a
 * session launched while CCC is in light mode keeps Claude's dark theme and its
 * user-message blocks render black on a light terminal. Book item 34: only the
 * local Claude path ever set it — SSH and Codex sessions came up dark. ONE
 * definition here, used by all three launch paths (local Claude env, Codex env,
 * SSH remote launch line).
 */

export type HostColorScheme = 'light' | 'dark'

/**
 * Resolves the host's effective light/dark scheme from the CCC theme setting.
 * 'light'/'dark' are explicit; 'system' (or absent, but absent defaults to the
 * app's dark default) follows the OS preference. Pure so it is table-testable;
 * the caller supplies the OS preference (Electron nativeTheme.shouldUseDarkColors).
 */
export function resolveHostColorScheme(
  themePref: string | undefined,
  systemPrefersDark: boolean,
): HostColorScheme {
  if (themePref === 'light') return 'light'
  if (themePref === 'system') return systemPrefersDark ? 'dark' : 'light'
  return 'dark'
}

/**
 * The COLORFGBG value for a host scheme. Format is "foreground;background" by
 * ANSI index; Claude reads the BACKGROUND field (7 / 9-15 = light, 0-6 / 8 =
 * dark). dark -> "15;0" matches the behaviour before the variable was ever
 * set, so dark mode is unchanged.
 */
export function colorFgBgValue(scheme: HostColorScheme): string {
  return scheme === 'light' ? '0;15' : '15;0'
}

/**
 * The `NAME=value` token for a REMOTE launch line, per remote shell. The value
 * carries a `;`, which ends a command in POSIX sh -- so the POSIX token is
 * single-quoted (`COLORFGBG='0;15' claude ...`); the Windows cmd token is bare
 * because buildWindowsClaudeCommand wraps every var as `set "NAME=value"&&`,
 * where the double quotes already cover the `;`.
 */
export function colorFgBgEnvToken(scheme: HostColorScheme, remote: 'posix' | 'windows-cmd'): string {
  const value = colorFgBgValue(scheme)
  return remote === 'posix' ? `COLORFGBG='${value}'` : `COLORFGBG=${value}`
}
