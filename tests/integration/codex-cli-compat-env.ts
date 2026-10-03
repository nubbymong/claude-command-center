// The environment and the Codex folder codex-cli-compat.test.ts runs the PATH
// `codex` with (PR 4 VM checkpoint, F4), apart from that file, whose spawn
// runs as soon as it is loaded, so this part is checked on every run of the
// suite without starting anything (codex-cli-compat-env.test.ts).
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { codexCliEnv } from '../../src/main/providers/codex/cli-env'

/** The temp-folder prefix of a run's Codex folder: only a folder of this
 *  prefix, directly in the temp folder, is ever removed. */
export const COMPAT_HOME_PREFIX = 'ccc-cli-compat-home-'

/** The app's own allowlisted Codex environment (codexCliEnv): none of the
 *  caller's CODEX_* or OPENAI_* variables, so nothing names the real Codex
 *  folder or a credential, and CODEX_HOME the run's fresh folder. */
export function compatProbeEnv(
  inherited: Readonly<Record<string, string | undefined>>,
  home: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  return codexCliEnv(inherited, home, platform)
}

/** Removes `home` when it is a folder of this file's prefix directly in the
 *  temp folder; anything else is left as it is (false). */
export function removeCompatHome(home: string): boolean {
  if (path.dirname(home) !== os.tmpdir() || !path.basename(home).startsWith(COMPAT_HOME_PREFIX)) return false
  fs.rmSync(home, { recursive: true, force: true })
  return true
}

/** Runs `fn` with a fresh, empty Codex folder, removed after it, however it
 *  ends. */
export function withCompatHome<T>(fn: (home: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), COMPAT_HOME_PREFIX))
  try {
    return fn(home)
  } finally {
    try { removeCompatHome(home) } catch { /* a leftover temp folder is harmless */ }
  }
}
