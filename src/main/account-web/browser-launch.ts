/**
 * browser-launch.ts — launch the USER'S OWN browser for an account sign-in (#216).
 *
 * The argv builder and the profile-dir resolver are PURE and exported, so the
 * decisions that matter can be tested without spawning Chrome.
 *
 * WHY THE SYSTEM BROWSER. An embedded Electron window loads no browser
 * extensions. #209 shipped one and it could not complete a login on a managed
 * workstation, because a compliance-mandated SSO plugin simply is not there. The
 * user's real Chrome has it. Verified on the target machine: Chrome's
 * `ExtensionInstallForcelist` is set under HKCU, and force-installed extensions
 * install into ANY profile — including the fresh one this module creates. That
 * single fact is what makes a dedicated profile viable instead of a dead end.
 *
 * WHY A DEDICATED PROFILE DIR. Chrome refuses `--remote-debugging-port` against
 * the DEFAULT profile (136+), so debugging the user's everyday profile is not
 * an option even if we wanted it — and we do not: CCC should never attach a
 * debugger to the browser the user is reading their mail in. A dedicated dir
 * means the user signs in fresh, CCC reads only what that sign-in produced, and
 * the dir can be destroyed afterwards.
 *
 * No default export (project convention).
 */

import { join } from 'node:path'
import { PROFILE_ID_RE } from '../../shared/account-web-session'

/** Browsers this module can drive. Same engine, same CDP. */
export type AuthBrowser = 'chrome' | 'edge'

/**
 * Per-account profile directory for the sign-in browser.
 *
 * Keyed by account so two accounts never share a browser profile — signing in
 * as B must not land in a directory still holding A's claude.ai session. The
 * profile id is re-validated because it becomes a filesystem path.
 */
export function authProfileDir(dataDir: string, profileId: string): string {
  if (!PROFILE_ID_RE.test(profileId)) {
    throw new Error(`refusing to build a browser profile dir for an unexpected profile id: ${profileId}`)
  }
  return join(dataDir, 'account-web', profileId)
}

export interface AuthBrowserArgs {
  port: number
  profileDir: string
  /** Where the browser opens. claude.ai only — this is a sign-in, not a browser. */
  startUrl?: string
}

/**
 * Build the launch argv.
 *
 * Deliberately NOT headless: the whole point is that a human completes SSO,
 * with their compliance plugin and their MFA. A headless flag here would
 * reproduce exactly the failure #209 hit.
 */
export function buildAuthBrowserArgs(a: AuthBrowserArgs): string[] {
  if (!Number.isInteger(a.port) || a.port < 1024 || a.port > 65535) {
    throw new Error(`refusing to launch a debug browser on an out-of-range port: ${a.port}`)
  }
  const url = a.startUrl ?? 'https://claude.ai/'
  if (!/^https:\/\/(www\.)?claude\.ai\//.test(url)) {
    // The start URL ends up on a command line and in a browser CCC is
    // debugging. It is a fixed destination, not a parameter a caller gets to
    // point anywhere.
    throw new Error(`refusing to open a sign-in browser at a non-claude.ai URL: ${url}`)
  }

  return [
    `--remote-debugging-port=${a.port}`,
    // Bind the debug endpoint to loopback. Anything that can reach this port can
    // read the claude.ai cookies while the browser is open, so it must never be
    // reachable off-box.
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${a.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // Suppress the "restore pages?" bubble and the default-browser nag on a
    // profile the user never chose to create.
    '--hide-crash-restore-bubble',
    url,
  ]
}

/** True when a set of args would launch headless — a sign-in never may. */
export function isHeadless(args: readonly string[]): boolean {
  return args.some((a) => a === '--headless' || a.startsWith('--headless='))
}
