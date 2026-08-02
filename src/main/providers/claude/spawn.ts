import * as os from 'os'
import { execSync } from 'child_process'
import { resolveVersionBinary } from '../../legacy-version-manager'
import { logInfo } from '../../debug-logger'
import type { LegacyVersion } from '../../../shared/types'
import type { SpawnOptions } from '../types'

/**
 * Resolves the host's effective light/dark scheme from the CCC theme setting.
 * 'light'/'dark' are explicit; 'system' (or absent, but absent defaults to the
 * app's dark default) follows the OS preference. Pure so it is table-testable;
 * the caller supplies the OS preference (Electron nativeTheme.shouldUseDarkColors).
 */
export function resolveHostColorScheme(
  themePref: string | undefined,
  systemPrefersDark: boolean,
): 'light' | 'dark' {
  if (themePref === 'light') return 'light'
  if (themePref === 'system') return systemPrefersDark ? 'dark' : 'light'
  return 'dark'
}

export function resolveClaudeBinary(legacyVersion?: LegacyVersion): { cmd: string; args: string[] } {
  if (legacyVersion?.enabled && legacyVersion.version) {
    const legacyBin = resolveVersionBinary(legacyVersion.version)
    if (legacyBin) {
      logInfo(`[claude-provider] Using legacy Claude CLI v${legacyVersion.version}: ${legacyBin}`)
      return { cmd: legacyBin, args: [] }
    }
    logInfo(`[claude-provider] Legacy v${legacyVersion.version} binary not found, falling back to system claude`)
  }

  if (os.platform() !== 'win32') return { cmd: 'claude', args: [] }

  for (const bin of ['claude.exe', 'claude.cmd']) {
    try {
      // stdio pipe on stderr suppresses the "INFO: Could not find files..."
      // noise that `where` writes to stderr on a miss; default execSync
      // inherits stderr so probe-fallthrough leaks into the parent's terminal.
      const cmdPath = execSync(`where ${bin}`, {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim().split('\n')[0].trim()
      return { cmd: cmdPath, args: [] }
    } catch { /* try next */ }
  }
  return { cmd: 'claude', args: [] }
}

/**
 * Build the bare shell + env for a local Claude (or shell-only) PTY spawn.
 *
 * Returns ONLY the shell binary, args, and env. The post-spawn shell-write
 * (cd + claude command + flags) is constructed and dispatched by pty-manager
 * because it depends on additional state (resume picker path, agents flag,
 * extra CLI flags) that is pty-manager's responsibility.
 */
export function buildClaudeLocalSpawn(opts: SpawnOptions): { cmd: string; args: string[]; env: Record<string, string> } {
  const env: Record<string, string> = { ...process.env, CLAUDE_MULTI_SESSION_ID: opts.sessionId } as Record<string, string>

  // Tell Claude Code (and any TUI) the host terminal's light/dark scheme via
  // COLORFGBG, which Claude reads FIRST when auto-detecting its theme. Without
  // this, a session launched while CCC is in light mode keeps Claude's dark
  // theme, so its user-message blocks render with dark/black backgrounds on the
  // light terminal. Format is "foreground;background" by ANSI index; Claude reads
  // the background field (7 / 9-15 = light, 0-6 / 8 = dark). Set for ALL session
  // kinds (the terminal IS this theme). dark -> "15;0" matches the prior implicit
  // behavior, so dark mode is unchanged; only theme detection runs at startup, so
  // this affects newly launched sessions, not ones already running.
  if (opts.hostColorScheme) {
    env.COLORFGBG = opts.hostColorScheme === 'light' ? '0;15' : '15;0'
  }

  if (opts.disableAutoMemory) env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'

  // Terminal-only secret argument. The secret goes in the ENV, and the launch
  // line references the variable rather than the value, so the plaintext never
  // reaches the shell's persistent history (PSReadLine writes every submitted
  // line to disk) or the config file. Same-user processes can still read the
  // env — that is the existing local-trust boundary, and it is strictly better
  // than a secret sitting in ConsoleHost_history.txt forever.
  if (opts.shellOnly && opts.terminalSecret) env.CCC_ARG_SECRET = opts.terminalSecret

  const shell = os.platform() === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash')
  // POSIX: spawn a LOGIN shell (-l) so PATH picks up Homebrew/nvm/npm-global
  // entries from ~/.zprofile. A Finder/Dock-launched app inherits launchd's
  // minimal PATH, and a non-login zsh never sources ~/.zprofile, so without
  // this every session hits "command not found: claude" while the onboarding
  // check (which already uses -l, see index.ts cli:check) passes.
  const shellArgs = os.platform() === 'win32' ? [] : ['-l']

  if (opts.shellOnly && opts.elevated) {
    const cmd = os.platform() === 'win32' ? 'gsudo' : 'sudo'
    return { cmd, args: [shell, ...shellArgs], env }
  }

  if (opts.shellOnly) {
    return { cmd: shell, args: shellArgs, env }
  }

  // Claude session: disable CC's mouse mode + alternate screen when classic copy/paste is
  // on (default true). Disabling mouse lets xterm own the mouse → classic text selection
  // + right-click copy/paste work the standard terminal way. Disabling the alternate screen
  // forces CC to use the inline renderer so conversation output stays in the terminal's
  // native scrollback — the mouse wheel then scrolls line-by-line through history instead
  // of sending arrow-key events (which the alt-screen fullscreen renderer would handle).
  // When the user opts out (classicTerminalCopyPaste === false), CC's mouse tracking and
  // alternate screen are restored and copy-on-select becomes active again.
  if (opts.classicTerminalCopyPaste !== false) {
    env.CLAUDE_CODE_DISABLE_MOUSE = '1'
    env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = '1'
  }

  // CC >= 2.1.195: question options render as clickable targets, which misfire
  // inside xterm.js (stray clicks answer prompts). The official opt-out is
  // CLAUDE_CODE_DISABLE_MOUSE_CLICKS (disables click/drag/hover, keeps wheel
  // scroll); older CC versions ignore the var. Off by default in CCC -- the
  // Settings toggle (clickableQuestions) opts back in per user choice.
  if (opts.clickableQuestions !== true) {
    env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS = '1'
  }

  // CC background tasks / agents: a stray Ctrl+B (or /bg) detaches the running
  // session into a background agent and strands the conversation (a beta tester
  // lost sessions twice this way). Default-on protective: absent/true disables
  // the feature so no keystroke can background a session. Set false to restore it.
  if (opts.disableBackgroundTasks !== false) {
    env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1'
  }

  // Claude session: spawn shell only; pty-manager writes the cd+claude command into the shell post-spawn.
  return { cmd: shell, args: shellArgs, env }
}
