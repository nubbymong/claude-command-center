/**
 * The login shell the CLI probes run through on macOS/Linux, so `which claude`
 * sees the PATH a user's shell profile builds (Homebrew, nvm, ~/.local/bin).
 *
 * `$SHELL` when the environment carries it. Without it the fallback used to be
 * `/bin/zsh` everywhere, which is right for macOS (its default shell since
 * 10.15) and wrong for Linux, where zsh is an optional package: the probe then
 * failed with ENOENT and the app reported the CLI missing on a machine that had
 * it (final adversarial pass, 2.1.1). `/bin/sh` is the one shell every Linux
 * install has, and `sh -l` still reads /etc/profile and ~/.profile.
 */
export function defaultLoginShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.SHELL) return env.SHELL
  return platform === 'darwin' ? '/bin/zsh' : '/bin/sh'
}
