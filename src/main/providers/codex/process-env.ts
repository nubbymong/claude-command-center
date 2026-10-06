// The environment a Codex setup or sign-in operation starts FROM, before the
// allowlist in cli-env.ts narrows it (WP2, plan A8). On macOS and Linux an app
// started from Finder, the Dock or a desktop launcher inherits a minimal PATH
// without Homebrew or npm's global bin -- the same reason the resolver asks a
// LOGIN shell where codex is. An npm-installed codex is a JS file with
// `#!/usr/bin/env node`, so the version check and every sign-in need that
// login shell's PATH too, or node is not found and the CLI reads as broken.
import { execFile } from 'node:child_process'
import { defaultLoginShell } from '../../login-shell'

const OPEN = '__CCC_CODEX_PATH_BEGIN__'
const CLOSE = '__CCC_CODEX_PATH_END__'

/** Keep only a PATH made of absolute directories: an empty or relative entry
 *  (`::`, `.`) would search the current folder. */
export function absolutePathEntries(value: string): string | null {
  const kept = value.split(':').filter((p) => p.startsWith('/'))
  return kept.length ? kept.join(':') : null
}

/** Read the PATH between the markers a login shell printed. Profile scripts
 *  may print before (a banner) or after (zsh's .zlogout) -- only the text
 *  between the LAST opening marker and the first closing marker after it
 *  counts. Exported for the test. */
export function extractMarkedPath(out: string): string | null {
  const open = out.lastIndexOf(OPEN)
  if (open < 0) return null
  const start = open + OPEN.length
  const end = out.indexOf(CLOSE, start)
  if (end < 0) return null
  const value = out.slice(start, end)
  if (!value || /[\r\n\0]/.test(value)) return null
  return absolutePathEntries(value)
}

/** The PATH a login shell sets up, or null (Windows, or the shell failed).
 *  The same login shell the session launch and the CLI probes use; run
 *  directly (no shell parses SHELL) and asynchronously, so a slow profile
 *  never blocks the main process. */
export function codexLoginShellPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  if (platform === 'win32') return Promise.resolve(null)
  const shell = defaultLoginShell(env, platform)
  return new Promise((resolve) => {
    execFile(shell, ['-l', '-c', `printf '%s%s%s' '${OPEN}' "$PATH" '${CLOSE}'`], { encoding: 'utf8', timeout: 8000 }, (err, stdout) => {
      resolve(err ? null : extractMarkedPath(String(stdout)))
    })
  })
}

/** The inherited environment with, on macOS and Linux, the login shell's
 *  PATH. Everything else is narrowed later by codexCliEnv. */
export async function codexOperationBaseEnv(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<Record<string, string | undefined>> {
  const loginPath = await codexLoginShellPath(env, platform)
  return loginPath ? { ...env, PATH: loginPath } : { ...env }
}
