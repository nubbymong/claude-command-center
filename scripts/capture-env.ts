/**
 * The training screenshot tool's home and launch environment (WP2 PR 4,
 * P4.11): the app it launches, and every path it seeds, use a home of their
 * own inside the tool's throwaway data root, never the real one. Before, the
 * tool renamed the running user's own `~/.claude/projects` and
 * `~/.codex/sessions` to hide them and launched the app on the real home (a
 * Claude session's `~/.claude/settings-<id>.json` and anything else the app
 * places by os.homedir() landed there too).
 *
 * The same isolated home the e2e harness gives each app instance
 * (tests/e2e/helpers/isolated-env.ts): USERPROFILE and HOME point inside the
 * data root, and the runner's CLAUDE_CONFIG_DIR and CODEX_HOME, which name
 * folders in the real home, go. The capture's own switches differ from a
 * test's: a production build with its window shown, so E2E_HEADLESS goes.
 *
 * No Playwright import, so the unit suite reads this directly
 * (tests/unit/scripts/capture-home.test.ts).
 */
import { isolatedHomeDir, isolatedLaunchEnv } from '../tests/e2e/helpers/isolated-env'

/** The capture's own home: inside its data root. */
export function captureHomeDir(dataRoot: string): string {
  return isolatedHomeDir(dataRoot)
}

/** The app's launch environment for the capture whose data root is
 *  `dataRoot`. Makes the home and its `.claude` folder. */
export function captureLaunchEnv(
  dataRoot: string,
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return isolatedLaunchEnv(dataRoot, { NODE_ENV: 'production', E2E_HEADLESS: undefined }, base)
}
