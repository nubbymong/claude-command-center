/**
 * sign-in.ts — drive one account's claude.ai sign-in in the user's own browser (#216).
 *
 * The flow: launch the system browser with a dedicated profile and a loopback
 * debug port, let the human complete SSO (compliance plugin and MFA included),
 * poll over CDP until claude.ai reports an authenticated account, harvest ONLY
 * the claude.ai cookies, inject them into that account's Electron partition, and
 * destroy the browser profile.
 *
 * The pure decisions live next door in `browser-launch.ts` and
 * `cookie-harvest.ts`; this file is the side-effecting shell around them.
 *
 * SECURITY NOTES, since this is the file an attacker reads first:
 *   - The debug port is loopback-only and open only while a sign-in is running.
 *     Anything that reaches it can read the claude.ai cookies, so the browser is
 *     killed and the profile removed as soon as the harvest succeeds or fails.
 *   - Cookies are injected into `persist:claude-web-<profileId>` and nowhere
 *     else; one partition per account is the isolation boundary.
 *   - CCC never reads the user's normal browser profile.
 *
 * No default export (project convention).
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { session as electronSession } from 'electron'
import { logError, logInfo } from '../debug-logger'
import { getBrowserPaths } from '../vision-manager'
import {
  AUTH_BROWSER_LABELS,
  DEFAULT_AUTH_BROWSER,
  webPartitionForProfile,
  type AccountWebSession,
} from '../../shared/account-web-session'
import { DEVTOOLS_PORT_FILE, authProfileDir, buildAuthBrowserArgs, type AuthBrowser } from './browser-launch'
import { harvestClaudeCookies, type CdpCookie } from './cookie-harvest'

/** Lazy require so a missing optional dep never crashes boot (mirrors vision-manager). */
let CDP: any = null
let cdpOverride: any = null
function getCDP(): any {
  if (cdpOverride) return cdpOverride
  if (!CDP) CDP = require('chrome-remote-interface')
  return CDP
}
/** Test seam: inject a fake chrome-remote-interface. Pass null to restore. */
export function _setCdpForTest(fake: any): void { cdpOverride = fake }

export type SignInPhase = 'idle' | 'launching' | 'awaiting-user' | 'harvesting' | 'done' | 'failed'

export interface SignInState {
  phase: SignInPhase
  profileId: string | null
  /** Populated on 'failed'. Shown to the user verbatim. */
  error?: string
  session?: AccountWebSession
  /** The browser actually launched — not necessarily the one asked for. */
  browser?: AuthBrowser
  /**
   * A non-fatal thing the user should know, shown verbatim alongside a result.
   *
   * Its one job today is to never let a browser substitution be silent. The
   * account chose a browser BECAUSE the browsers behave differently at the
   * identity provider, so falling back without saying so would turn a working
   * setting into an unexplained SSO failure.
   */
  notice?: string
}

let current: SignInState = { phase: 'idle', profileId: null }
let child: ChildProcess | null = null
let cancelled = false

export function getSignInState(): SignInState {
  return current
}

/** Resolve the first system browser binary that exists. */
export function resolveBrowserBinary(preferred: AuthBrowser = DEFAULT_AUTH_BROWSER): { browser: AuthBrowser; path: string } | null {
  for (const b of [preferred, preferred === 'chrome' ? 'edge' : 'chrome'] as AuthBrowser[]) {
    for (const p of getBrowserPaths(b)) {
      if (existsSync(p)) return { browser: b, path: p }
    }
  }
  return null
}

/**
 * Read the port Chrome actually bound, from the file only the process owning
 * this profile dir can write.
 *
 * This is the verification half of the ephemeral-port decision: it yields the
 * port AND proves the endpoint belongs to the browser CCC launched, rather than
 * to whatever got to a published port first.
 */
async function waitForDebugPort(profileDir: string, deadline: number): Promise<number | null> {
  const file = join(profileDir, DEVTOOLS_PORT_FILE)
  while (Date.now() < deadline && !cancelled) {
    try {
      const first = readFileSync(file, 'utf-8').split('\n')[0]?.trim()
      const port = Number(first)
      if (Number.isInteger(port) && port > 0) return port
    } catch { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  return null
}

/**
 * Tear the browser down and remove the profile dir.
 *
 * AWAITS the child's exit before deleting: on Windows a just-killed Chrome still
 * holds handles on `Cookies` and `LOCK`, so an immediate rmSync throws EBUSY and
 * leaves a directory containing a LIVE claude.ai session behind. Retries for the
 * same reason.
 */
async function cleanup(profileDir: string | null): Promise<void> {
  const proc = child
  child = null
  if (proc && !proc.killed) {
    try {
      killBrowserTree(proc)
      await Promise.race([
        new Promise((r) => proc.once('exit', r)),
        new Promise((r) => setTimeout(r, 5000)),
      ])
    } catch { /* already gone */ }
  }
  if (profileDir && existsSync(profileDir)) {
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    } catch (err) {
      // Worth shouting about: what is left behind is a browser profile holding a
      // LIVE claude.ai session. `sweepAbandonedProfiles` clears it at next boot.
      logError(`[account-web] could not remove the sign-in profile dir (retried): ${(err as Error)?.message}`)
    }
  }
}

/**
 * Kill the browser AND its children.
 *
 * `proc.kill()` signals only the process we spawned. Chrome and Edge are process
 * TREES — renderers, GPU, network, utility — and those children keep open
 * handles on the profile directory. Observed 2026-08-08: the harvest succeeded,
 * `proc.kill()` returned, `proc` reported exit, and the very next `rmSync` threw
 *
 *   EPERM, Permission denied: ...\account-web\profile-mrbhy8is-b85405
 *
 * leaving a directory on disk that still contained `sessionKey`. That is the
 * exact outcome this module's dedicated-profile design exists to prevent, so the
 * teardown has to take the whole tree with it.
 */
function killBrowserTree(proc: ChildProcess): void {
  const pid = proc.pid
  if (!pid) return
  if (process.platform === 'win32') {
    // /T = tree, /F = force. Windows has no process-group kill for this.
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* fall through */ }
  }
  // Always signal directly too: on win32 this catches a taskkill that could not
  // run, and elsewhere it is the whole mechanism.
  try { proc.kill() } catch { /* already gone */ }
}

/**
 * Remove any sign-in profile dirs left by a crash or a forced quit.
 *
 * Each one holds a live claude.ai session and, until it is gone, a browser could
 * still be running against it. Called at startup.
 */
export function sweepAbandonedProfiles(dataDir: string): void {
  const root = join(dataDir, 'account-web')
  if (!existsSync(root)) return
  for (const entry of readdirSync(root)) {
    try {
      rmSync(join(root, entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      logInfo(`[account-web] swept an abandoned sign-in profile: ${entry}`)
    } catch { /* a live one will be swept next boot */ }
  }
}

/** The bits of a CDP target this module uses. */
export interface CdpTarget {
  type?: string
  url?: string
  id?: string
  webSocketDebuggerUrl?: string
}

/** True for a URL served by claude.ai itself. Anything unparseable is not. */
function isClaudeUrl(url: string | undefined): boolean {
  try {
    const host = new URL(url ?? '').hostname.toLowerCase()
    return host === 'claude.ai' || host === 'www.claude.ai'
  } catch {
    return false
  }
}

/**
 * The claude.ai page targets worth asking "who is signed in?", best first.
 *
 * PURE, and the reason this exists is a bug that cost a whole test round.
 * `chrome-remote-interface` connects to the FIRST page target it is offered,
 * and on a real sign-in that is not the tab the human is using. Captured from an
 * actual launch on 2026-08-08, the list held, in this order: an extension's own
 * `claude.ai/oauth/authorize?...redirect_uri=chrome-extension://...` handshake
 * page, then `claude.ai/login`, then the account-selection tab. The poller bound
 * to the extension's page — same origin, so every other check passed — and when
 * that transient page went away the connection was dead for the rest of the
 * sign-in. The user logged in successfully and nothing was ever harvested, with
 * no error logged anywhere.
 *
 * So: enumerate rather than assume, and deprioritise (never exclude) the pages
 * that belong to an extension completing its own OAuth. The caller tries each in
 * turn, which means no single guess has to be right.
 */
export function pickSignInTargets(targets: readonly CdpTarget[] | null | undefined): CdpTarget[] {
  const pages = (targets ?? []).filter((t) => t?.type === 'page' && isClaudeUrl(t?.url))
  const extensionOwned = (t: CdpTarget): boolean => /redirect_uri=chrome-extension/i.test(t.url ?? '')
  return [...pages.filter((t) => !extensionOwned(t)), ...pages.filter(extensionOwned)]
}

/** Close a CDP client without letting a teardown error mask the real outcome. */
async function closeQuietly(client: any): Promise<void> {
  try { await client?.close() } catch { /* closing anyway */ }
}

/** Ask the page for the signed-in account, via claude.ai's own bootstrap. */
async function readAccountEmail(client: any): Promise<string | null> {
  try {
    // The fetch below is ORIGIN-RELATIVE, so it only means what we think if the
    // evaluated target is actually claude.ai. During an SSO hop the first target
    // can be the identity provider, and a page that answers with an
    // account-shaped object would otherwise label the stored session with an
    // unrelated email.
    try {
      const { url } = (await client.Target?.getTargetInfo?.())?.targetInfo ?? {}
      if (typeof url === 'string' && url) {
        const host = new URL(url).hostname.toLowerCase()
        if (host !== 'claude.ai' && host !== 'www.claude.ai') return null
      }
    } catch { /* no Target domain — fall through to the fetch */ }

    const { result } = await client.Runtime.evaluate({
      expression: `fetch('/api/bootstrap',{credentials:'include'}).then(r=>r.json()).then(j=>j?.account?.email_address ?? null).catch(()=>null)`,
      awaitPromise: true,
      returnByValue: true,
    })
    return typeof result?.value === 'string' ? result.value : null
  } catch {
    return null
  }
}

export interface RunSignInOpts {
  profileId: string
  dataDir: string
  /** How long to wait for the human, ms. SSO with MFA is not fast. */
  timeoutMs?: number
  pollMs?: number
  /**
   * Which system browser to drive. The ACCOUNT'S setting, resolved by the
   * caller — this module does not read the store, so it stays testable without
   * one. Omitted falls back to the shared default rather than to Chrome.
   */
  browser?: AuthBrowser
}

/** True while a sign-in is in flight. */
function inFlight(): boolean {
  return current.phase === 'launching' || current.phase === 'awaiting-user' || current.phase === 'harvesting'
}

/**
 * Run the whole sign-in. Resolves with the final state; never throws.
 *
 * Success requires BOTH an authenticated bootstrap and a real session cookie —
 * a jar without `sessionKey` would leave the partition looking signed in while
 * every request 401s.
 */
export async function runSignIn(opts: RunSignInOpts): Promise<SignInState> {
  const { profileId, dataDir } = opts
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000
  const pollMs = opts.pollMs ?? 1500

  // SINGLE FLIGHT. Two concurrent sign-ins would share `child`, `cancelled` and
  // `current`, so the second would overwrite the first's process handle — and
  // cleanup would then kill the wrong browser while the first's cookies were
  // harvested into the second's partition. That is precisely the cross-account
  // bleed the per-account partition exists to prevent, reachable with no
  // attacker at all: the UI renders one sign-in button per account row.
  if (inFlight()) {
    return { phase: 'failed', profileId, error: 'A sign-in is already in progress. Finish or cancel it first.' }
  }

  cancelled = false

  // Resolve INSIDE the guarded path. Both of these validate the profile id and
  // throw on a bad one, and this function's contract is that it never throws —
  // a caller that got a state object for every other failure must not get an
  // exception for this one.
  let partition: string
  let profileDir: string
  try {
    partition = webPartitionForProfile(profileId)
    profileDir = authProfileDir(dataDir, profileId)
  } catch (err) {
    current = { phase: 'failed', profileId, error: (err as Error)?.message ?? String(err) }
    return current
  }

  current = { phase: 'launching', profileId }

  const requested = opts.browser ?? DEFAULT_AUTH_BROWSER
  const bin = resolveBrowserBinary(requested)
  if (!bin) {
    current = {
      phase: 'failed',
      profileId,
      error: 'No Chrome or Edge found. A system browser is required: the sign-in needs the SSO support your policy installs, which an in-app window does not have.',
    }
    return current
  }

  const browser = bin.browser
  // A SUBSTITUTION IS NEVER SILENT. The account picked a browser because the two
  // do not behave the same at the identity provider — on a managed box Chrome
  // needs a force-installed SSO extension that a fresh profile has not fetched
  // yet, and Edge needs none. Quietly launching the other one turns that setting
  // into an SSO failure with no visible cause. Still a fallback rather than a
  // refusal: a machine with only one of them should be able to sign in.
  const notice =
    browser === requested
      ? undefined
      : `${AUTH_BROWSER_LABELS[requested]} is not installed, so ${AUTH_BROWSER_LABELS[browser]} was used instead. If the sign-in fails at your identity provider, install ${AUTH_BROWSER_LABELS[requested]}.`

  /** Stamp the browser that actually launched onto every state the UI sees. */
  const tag = (s: SignInState): SignInState => ({ ...s, browser, ...(notice ? { notice } : {}) })

  // Set when the browser goes away on its own. Without this, closing the window
  // mid-sign-in left the poll loop talking to nothing for the full five-minute
  // timeout and then blaming the timeout — which is not what happened.
  let browserExited = false

  try {
    const args = buildAuthBrowserArgs({ profileDir })
    logInfo(`[account-web] launching ${bin.browser} for ${profileId} on an ephemeral loopback port`)
    child = spawn(bin.path, args, { detached: false, stdio: 'ignore' })
    child.on('error', (err) => logError(`[account-web] browser spawn error: ${err.message}`))
    child.on('exit', () => { browserExited = true })

    current = tag({ phase: 'awaiting-user', profileId })
    const deadline = Date.now() + timeoutMs

    // Read the port from the profile dir rather than assuming one. Only the
    // process that owns this dir writes that file, so this both discovers the
    // port and establishes the endpoint is OUR browser — a fixed port could be
    // answered by anything local that got there first.
    const port = await waitForDebugPort(profileDir, deadline)
    if (port === null) {
      await cleanup(profileDir)
      current = tag({
        phase: 'failed',
        profileId,
        error: cancelled ? 'Sign-in cancelled.' : 'The browser did not report a debugging port. It may have been blocked from starting.',
      })
      return current
    }

    while (Date.now() < deadline && !cancelled && !browserExited) {
      await new Promise((r) => setTimeout(r, pollMs))
      if (cancelled || browserExited) break

      // RE-ENUMERATE EVERY POLL rather than holding one connection to whichever
      // target CDP offered first. A sign-in creates and destroys claude.ai pages
      // as it goes — a login tab, an account-selection hop, an extension doing
      // its own OAuth — so both "which target" and "is it still alive" change
      // underneath a long-lived connection. Reconnecting each poll costs one
      // loopback websocket every 1.5s and removes the entire class of bug.
      let targets: CdpTarget[] = []
      try { targets = await getCDP().List({ port }) } catch { continue }

      for (const t of pickSignInTargets(targets)) {
        let client: any = null
        try {
          client = await getCDP()({ port, target: t.webSocketDebuggerUrl ?? t.id })
        } catch { continue }

        const email = await readAccountEmail(client)
        if (!email) { await closeQuietly(client); continue }

        // Authenticated. Harvest.
        current = tag({ phase: 'harvesting', profileId })
        const all: CdpCookie[] = (await client.Network.getAllCookies())?.cookies ?? []
        const harvest = harvestClaudeCookies(all)

        if (!harvest.hasSessionCookie) {
          // Keep waiting rather than declaring success on a cookie-less jar.
          current = tag({ phase: 'awaiting-user', profileId })
          await closeQuietly(client)
          continue
        }

        const store = electronSession.fromPartition(partition)
        for (const c of harvest.cookies) {
          try { await store.cookies.set(c) } catch (err) {
            logError(`[account-web] could not set cookie ${c.name}: ${(err as Error)?.message}`)
          }
        }

        await closeQuietly(client)
        await cleanup(profileDir)

        const acquired: AccountWebSession = {
          profileId,
          accountEmail: email,
          acquiredAt: Date.now(),
          expiresAt: harvest.expiresAt,
          origin: 'system-browser',
        }
        logInfo(`[account-web] ${profileId}: signed in as ${email}, ${harvest.cookies.length} cookie(s), ${harvest.dropped} dropped`)
        current = tag({ phase: 'done', profileId, session: acquired })
        return current
      }
    }

    await cleanup(profileDir)
    current = tag({
      phase: 'failed',
      profileId,
      error: cancelled
        ? 'Sign-in cancelled.'
        // Distinguishable on purpose: waiting out a five-minute timeout because
        // the window is already gone tells the user nothing about what to do.
        : browserExited
          ? 'The sign-in browser was closed before the session could be collected. Sign in again and leave the window open until this panel says you are signed in.'
          : 'Timed out waiting for the sign-in to complete.',
    })
    return current
  } catch (err) {
    await cleanup(profileDir)
    current = tag({ phase: 'failed', profileId, error: (err as Error)?.message ?? String(err) })
    return current
  }
}

/** Cancel an in-flight sign-in and tear the browser down. */
export function cancelSignIn(): void {
  cancelled = true
}

/**
 * Forget one account's web session — used on account delete and on sign-out.
 *
 * Clears the WHOLE partition, not just cookies: claude.ai also leaves
 * localStorage, IndexedDB and cache behind, and "signed out" should not mean
 * "the cookie is gone but the account's data is still on disk".
 */
export async function clearWebSession(profileId: string): Promise<void> {
  const store = electronSession.fromPartition(webPartitionForProfile(profileId))
  await store.clearStorageData()
  logInfo(`[account-web] cleared the web session for ${profileId}`)
}
