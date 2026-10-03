import { existsSync } from 'fs'

/**
 * The login shell the CLI probes AND the local Claude session launch run
 * through on macOS/Linux, so `which claude` and the spawned session see the
 * PATH a user's shell profile builds (Homebrew, nvm, ~/.local/bin).
 *
 * `$SHELL` when the environment carries it. Without it the probes used to fall
 * back to `/bin/zsh` everywhere and the session launch to `/bin/bash`, so on a
 * Linux box without zsh the probe failed with ENOENT ("Claude CLI not found")
 * while the launch would have worked, and on one without bash the reverse
 * (final adversarial pass, 2.1.1). One rule for all of them: on macOS zsh, the
 * platform default since 10.15; elsewhere the first of bash, zsh, sh that
 * exists -- bash because it is the common Linux default and what the launch
 * always fell back to, zsh so a zsh-only box keeps working, `/bin/sh` because
 * every install has it. The probe and the launch now agree on the shell; what
 * PATH that shell builds is the user's profile's business (a non-interactive
 * `bash -l` reads ~/.profile, not ~/.bashrc).
 */
export function defaultLoginShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  if (env.SHELL) return env.SHELL
  if (platform === 'darwin') return '/bin/zsh'
  for (const candidate of ['/bin/bash', '/bin/zsh']) {
    if (exists(candidate)) return candidate
  }
  return '/bin/sh'
}

/** The shell a local session's PTY runs: PowerShell on Windows, the login
 *  shell above elsewhere (defaultLoginShell, with the same environment and
 *  file test). */
export function localSessionShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  return platform === 'win32' ? 'powershell.exe' : defaultLoginShell(env, platform, exists)
}

/** The sh family, by name: the shells Alt+V types an image path into off
 *  Windows (PR-level ADR-009 round 1, A1). */
const SH_FAMILY = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

/** PR-level ADR-009 round 1 (A1): whether `shell` (a path or a name) is one of
 *  the sh family by its basename: sh, bash, zsh, dash, ksh, and no other. */
export function isShFamilyShell(shell: string): boolean {
  if (typeof shell !== 'string') return false
  const base = shell.split(/[\\/]/).pop() ?? ''
  return SH_FAMILY.has(base)
}
