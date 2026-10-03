/**
 * The training screenshot tool's home and launch environment (WP2 PR 4,
 * P4.11): the app it launches, and every path it seeds, use a home of their
 * own inside the tool's throwaway data root, never the real one. Before, the
 * tool renamed the running user's own Claude projects and Codex sessions
 * folders to hide them and launched the app on the real home (a
 * Claude session's `~/.claude/settings-<id>.json` and anything else the app
 * places by os.homedir() landed there too).
 *
 * The same isolated home the e2e harness gives each app instance
 * (tests/e2e/helpers/isolated-env.ts): USERPROFILE and HOME point inside the
 * data root, and the runner's variables naming Claude's and Codex's own
 * folders in the real home go. The capture's own switches differ from a
 * test's: a production build with its window shown, so E2E_HEADLESS goes.
 *
 * With Codex on (the P4.11 recapture shows both assistants), the app also
 * places files by the user's app data and temp folders: on Windows the Codex
 * hooks' plain copies go under %LOCALAPPDATA% when the resources folder's path
 * has a space (codex/hooks.ts), and the Codex version check, the vision
 * browser's profile and Codex's scratch folders go under the temp folder. So
 * the capture gives the app those folders inside the data root too, and puts
 * its own stand-in Claude and Codex CLIs (capture-seed.ts) first on a PATH
 * that no longer holds any real Claude or Codex, so no real CLI ever runs
 * against the real ~/.claude or ~/.codex.
 *
 * No Playwright import, so the unit suite reads this directly
 * (tests/unit/scripts/capture-home.test.ts, capture-seed.test.ts).
 */
import fs from 'fs'
import path from 'path'
import { isolatedHomeDir, isolatedLaunchEnv } from '../tests/e2e/helpers/isolated-env'

/** The capture's own home: inside its data root. */
export function captureHomeDir(dataRoot: string): string {
  return isolatedHomeDir(dataRoot)
}

/** Where the capture's stand-in Claude and Codex CLIs live. */
export function captureFakeBinDir(dataRoot: string): string {
  return path.join(dataRoot, 'fake-bin')
}

/** The app's temp folder during a capture. */
export function captureTempDir(dataRoot: string): string {
  return path.join(dataRoot, 'tmp')
}

/** What a real Claude or Codex install puts on PATH, on any platform. */
const ASSISTANT_CLI_NAMES = [
  'claude', 'claude.exe', 'claude.cmd', 'claude.bat', 'claude.ps1',
  'codex', 'codex.exe', 'codex.cmd', 'codex.bat', 'codex.ps1',
]

/** The folders on `pathValue` minus every one that holds a Claude or Codex
 *  CLI (and minus empty entries). */
export function pathWithoutAssistantClis(
  pathValue: string,
  delimiter: string = path.delimiter,
  exists: (p: string) => boolean = fs.existsSync,
): string[] {
  return pathValue.split(delimiter).filter((d) => {
    if (!d) return false
    return !ASSISTANT_CLI_NAMES.some((n) => {
      try { return exists(path.join(d.replace(/^"|"$/g, ''), n)) } catch { return false }
    })
  })
}

/** The value of `name` in `env`, whatever its case (Windows keeps `Path`). */
function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : env[key]
}

/** The app's launch environment for the capture whose data root is
 *  `dataRoot`. Makes the home, its `.claude` folder, the app data folders
 *  and the temp folder. */
export function captureLaunchEnv(
  dataRoot: string,
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const home = captureHomeDir(dataRoot)
  const localAppData = path.join(home, 'AppData', 'Local')
  const appData = path.join(home, 'AppData', 'Roaming')
  const tmp = captureTempDir(dataRoot)
  for (const d of [localAppData, appData, tmp]) fs.mkdirSync(d, { recursive: true })
  const fakeBin = captureFakeBinDir(dataRoot)
  const searchPath = [fakeBin, ...pathWithoutAssistantClis(envValue(base, 'PATH') ?? '')].join(path.delimiter)
  return isolatedLaunchEnv(dataRoot, {
    NODE_ENV: 'production',
    E2E_HEADLESS: undefined,
    LOCALAPPDATA: localAppData,
    APPDATA: appData,
    TEMP: tmp,
    TMP: tmp,
    TMPDIR: tmp,
    PATH: searchPath,
    // macOS and Linux find the CLIs through a login shell, whose profile may
    // put a real one back on PATH; the stand-in shell searches this PATH only.
    ...(process.platform === 'win32' ? {} : { SHELL: path.join(fakeBin, 'login-shell') }),
  }, base)
}
