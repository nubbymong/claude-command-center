/**
 * browser-launch.ts — launch the USER'S OWN browser for an account sign-in (#216).
 *
 * The argv builder and the profile-dir resolver are PURE and exported, so the
 * decisions that matter can be tested without spawning Chrome.
 *
 * WHY THE SYSTEM BROWSER. An embedded Electron window loads no browser
 * extensions and has no OS identity, so #209's in-app window could not complete a
 * login on a managed workstation. The user's own browser can.
 *
 * WHICH system browser is the ACCOUNT'S CHOICE, and the reason is a correction to
 * this file's first draft. It argued that because Chrome's
 * `ExtensionInstallForcelist` is set under HKCU, force-installed extensions
 * install into ANY profile including the fresh one created here, and that this was
 * what made a dedicated profile viable. The policy claim is true; the TIMING is
 * not. Measured 2026-08-06: Chrome fetches force-installed extensions
 * asynchronously after launch, so claude.ai loads before `Microsoft Single Sign
 * On` exists and the SSO step fails in a fresh profile. Edge does Entra SSO
 * natively, with nothing to wait for, and completed the same login. Hence
 * `AuthBrowser` and an Edge default — see `shared/account-web-session.ts`.
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

/**
 * Browsers this module can drive. Same engine, same CDP, same argv — but NOT
 * interchangeable for SSO, which is why the account picks one. The type and the
 * default live in `shared/` because the renderer's picker needs them too;
 * re-exported here so this module stays the one place launching is described.
 */
export type { AuthBrowser } from '../../shared/account-web-session'

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
  profileDir: string
  /** Where the browser opens. claude.ai only — this is a sign-in, not a browser. */
  startUrl?: string
}

/** The file Chrome writes the real port into when launched with port 0. */
export const DEVTOOLS_PORT_FILE = 'DevToolsActivePort'

/**
 * Build the launch argv.
 *
 * THE PORT IS EPHEMERAL (`=0`), and that is a security decision, not a tidiness
 * one. Chrome's CDP endpoint has NO AUTHENTICATION: any local process that can
 * reach it can read the claude.ai cookies out of the browser, or answer as the
 * browser. On a fixed, published port both are trivial — a squatter listening
 * there before a sign-in starts can hand CCC an attacker's `sessionKey` and have
 * it written into the user's partition. Loopback binding is not a control
 * against local code; unpredictability plus verification is.
 *
 * Chrome writes the real port to `<profileDir>/DevToolsActivePort`, which only
 * the process owning that profile dir can produce — so reading the port from
 * there is also what proves the endpoint is the browser CCC launched.
 *
 * It also removes a collision: two sign-ins can no longer contend for one port.
 *
 * Deliberately NOT headless: the whole point is that a human completes SSO with
 * their compliance plugin and their MFA. A headless flag here would reproduce
 * exactly the failure #209 hit.
 */
export function buildAuthBrowserArgs(a: AuthBrowserArgs): string[] {
  const url = a.startUrl ?? 'https://claude.ai/'
  if (!/^https:\/\/(www\.)?claude\.ai\//.test(url)) {
    // The start URL ends up on a command line and in a browser CCC is
    // debugging. It is a fixed destination, not a parameter a caller gets to
    // point anywhere.
    throw new Error(`refusing to open a sign-in browser at a non-claude.ai URL: ${url}`)
  }

  return [
    // 0 = ephemeral; the real port is read back from DevToolsActivePort.
    '--remote-debugging-port=0',
    // Bind the debug endpoint to loopback. Anything that can reach this port can
    // read the claude.ai cookies while the browser is open, so it must never be
    // reachable off-box. This is necessary, not sufficient — see the port note.
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
