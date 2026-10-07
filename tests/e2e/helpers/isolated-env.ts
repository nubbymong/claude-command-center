/**
 * The environment an e2e app instance runs with (P3.16, M7).
 *
 * Each instance gets a home of its own inside its own mkdtemp data dir
 * (`<dataDir>/home`), so nothing the app writes under the user's home lands in
 * the runner's real home: a Claude session's `~/.claude/settings-<id>.json`
 * (and its MCP and status sidecars) is placed by os.homedir() and removed only
 * when the session's process exits, which a tree-killed test app never reports.
 * Removing the data dir (closeIsolatedApp) removes the home with it. Node's
 * os.homedir() reads USERPROFILE on Windows and HOME elsewhere, so both are
 * set. The runner's CLAUDE_CONFIG_DIR and CODEX_HOME name folders in the real
 * home, so they go; a spec that needs its own gives it in `extra`.
 *
 * CCC_FORCE_SPLASH is pinned off: the splash is gated out for e2e (the first
 * window must be the main window). One left exported in the dev shell (e.g.
 * after running the splash probe) would otherwise make the splash the first
 * window and time out every spec with no obvious cause.
 *
 * Every key is set whatever its case in the runner's environment: Windows keeps
 * one variable per name, case-insensitively (`Path`), and two spellings in one
 * environment block leave which one wins to chance. `undefined` removes one.
 *
 * No Playwright import, so the unit suite reads this directly
 * (tests/unit/e2e-isolated-env.test.ts).
 */
import path from 'path'
import fs from 'fs'

/** The instance's own home: inside its data dir. */
export function isolatedHomeDir(dataDir: string): string {
  return path.join(dataDir, 'home')
}

/** The launch environment for the instance whose data dir is `dataDir`: the
 *  runner's (`base`), the app's e2e switches, the isolated home, then `extra`.
 *  Makes the home and its `.claude` folder. */
export function isolatedLaunchEnv(
  dataDir: string,
  extra: Record<string, string | undefined> = {},
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const home = isolatedHomeDir(dataDir)
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  const env: Record<string, string | undefined> = { ...base }
  const set = (key: string, value: string | undefined): void => {
    for (const existing of Object.keys(env)) {
      if (existing.toLowerCase() === key.toLowerCase()) delete env[existing]
    }
    if (value !== undefined) env[key] = value
  }
  const fixed: Record<string, string | undefined> = {
    NODE_ENV: 'test',
    E2E_HEADLESS: '1',
    CCC_E2E_DATA_DIR: dataDir,
    CCC_FORCE_SPLASH: '0',
    USERPROFILE: home,
    HOME: home,
    CLAUDE_CONFIG_DIR: undefined,
    CODEX_HOME: undefined,
  }
  for (const [key, value] of Object.entries(fixed)) set(key, value)
  for (const [key, value] of Object.entries(extra)) set(key, value)
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined))
}
