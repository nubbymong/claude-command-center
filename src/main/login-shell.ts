import { existsSync } from 'fs'

/**
 * The login shell the CLI probes run through on macOS/Linux, so `which claude`
 * sees the PATH a user's shell profile builds (Homebrew, nvm, ~/.local/bin).
 *
 * `$SHELL` when the environment carries it. Without it the fallback used to be
 * `/bin/zsh` everywhere, which is right for macOS (its default shell since
 * 10.15) and wrong for Linux, where zsh is an optional package: the probe then
 * failed with ENOENT and the app reported the CLI missing on a machine that had
 * it (final adversarial pass, 2.1.1). On Linux prefer bash, the common default
 * and the shell the Claude/Codex spawn paths already fall back to, so the probe
 * and the launch agree on what PATH looks like (a login bash reads ~/.profile,
 * which on Debian/Ubuntu sources ~/.bashrc, where nvm writes its PATH; dash
 * skips that block). `/bin/sh` is the last resort every install has.
 */
export function defaultLoginShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  if (env.SHELL) return env.SHELL
  if (platform === 'darwin') return '/bin/zsh'
  return exists('/bin/bash') ? '/bin/bash' : '/bin/sh'
}
