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
 *   - The browser binary is resolved from the system-wide install locations
 *     first and, on Windows, the per-user %LOCALAPPDATA% install last
 *     (aicc_planning#43). That last location is user-writable, which adds no
 *     principal boundary: whoever can plant a binary there already runs as this
 *     user, and the app never runs elevated or as a service with a borrowed
 *     environment. No shell is involved -- the path goes to spawn() as argv[0].
 *
 * No default export (project convention).
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { session as electronSession } from 'electron'
import { logError, logInfo } from '../debug-logger'
// From `browser-paths`, NOT `vision-manager`. Importing it from there dragged the
// vision stack — and `conductor-mcp-server` -> `update-watcher` -> `app.isPackaged`
// — into this module's graph, which broke an unrelated test three hops away.
import { getBrowserPaths } from '../browser-paths'
import {
  AUTH_BROWSER_LABELS,
  DEFAULT_AUTH_BROWSER,
  DEFAULT_CLI_AUTH_METHOD,
  PROFILE_ID_RE,
  webPartitionForProfile,
  type AccountWebSession,
  type CliAuthMethod,
} from '../../shared/account-web-session'
import { DEVTOOLS_PORT_FILE, authProfileDir, buildAuthBrowserArgs, type AuthBrowser } from './browser-launch'
import { harvestClaudeCookies, type CdpCookie } from './cookie-harvest'
import { closeInAppSignInWindow, runInAppSignIn } from './in-app-sign-in'
// A wipe must forget the web-session record and close the account's pane
// surfaces. Those owners subscribe via this zero-dependency seam so sign-in.ts
// keeps its narrow module graph (#439 adversarial A9) — importing session-store
// / account-pane here would drag their heavy transitive graph in.
import { notifyPartitionRevoked } from './partition-revocation'

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

/**
 * Resolve the first installed browser binary that exists -- system-wide or, on
 * Windows, the per-user install under %LOCALAPPDATA% (aicc_planning#43).
 */
export function resolveBrowserBinary(preferred: AuthBrowser = DEFAULT_AUTH_BROWSER): { browser: AuthBrowser; path: string } | null {
  for (const b of [preferred, preferred === 'chrome' ? 'edge' : 'chrome'] as AuthBrowser[]) {
    for (const p of getBrowserPaths(b)) {
      if (existsSync(p)) return { browser: b, path: p }
    }
  }
  return null
}

/**
 * Which of the drivable browsers are actually installed (#439): the Settings
 * picker only shows when there is a real choice to make. resolveBrowserBinary
 * falls back to the other browser, so "did MY paths resolve" is read off the
 * returned browser matching the one asked for.
 */
export function detectAuthBrowsers(): AuthBrowser[] {
  return (['edge', 'chrome'] as AuthBrowser[]).filter((b) => resolveBrowserBinary(b)?.browser === b)
}

/**
 * Read the port Chrome actually bound, from the file only the process owning
 * this profile dir can write.
 *
 * This is the verification half of the ephemeral-port decision: it yields the
 * port AND proves the endpoint belongs to the browser CCC launched, rather than
 * to whatever got to a published port first.
 */
async function waitForDebugPort(
  profileDir: string,
  deadline: number,
  // WATCH FOR A BROWSER THAT DIED ON THE WAY UP. Without this, a browser blocked
  // from starting (policy, AV, a bad binary) was waited on for the FULL five
  // minutes, and single-flight refused every other account's sign-in for that
  // whole time. The poll loop below already respects browserExited; this loop
  // runs before it and did not.
  exited: () => boolean = () => false,
): Promise<number | null> {
  const file = join(profileDir, DEVTOOLS_PORT_FILE)
  while (Date.now() < deadline && !cancelled && !exited()) {
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
  // `killed` only reports that a signal was SENT, so it stays false after a
  // browser the user closed themselves. Asking whether it has actually been
  // reaped is what keeps teardown from signalling a dead pid and from waiting
  // out the full five seconds for an 'exit' event that already fired.
  const alive = !!proc && proc.exitCode === null && proc.signalCode === null
  if (proc && alive) {
    try {
      killBrowserTree(proc)
      await Promise.race([
        new Promise((r) => proc.once('exit', r)),
        new Promise((r) => {
          const t = setTimeout(r, 5000)
          if (typeof (t as any)?.unref === 'function') (t as any).unref()
        }),
      ])
    } catch { /* already gone */ }
  }
  if (profileDir && existsSync(profileDir)) {
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    } catch (err) {
      // What is left behind is a browser profile holding a LIVE claude.ai
      // session, so this does not get to be a one-shot attempt that shrugs and
      // waits for the next boot.
      logError(`[account-web] sign-in profile dir still locked, retrying in the background: ${(err as Error)?.message}`)
      retryProfileRemoval(profileDir)
    }
  }
}

/** Backoff for the background removal, ms. Exported so a test need not wait. */
export const PROFILE_REMOVAL_RETRIES_MS: readonly number[] = [2_000, 5_000, 15_000, 45_000]

/**
 * Which run currently owns each profile dir.
 *
 * `authProfileDir` is DETERMINISTIC per account, so a second sign-in for the
 * same account lands on the exact same path a previous run may still be
 * background-retrying. Without an owner check, a user who signs in again a few
 * seconds after a "still locked, retrying" failure gets their BRAND NEW browser
 * profile — cookie DB included — deleted out from under the running browser by
 * the old run's timer. Demonstrated with a repro; no attacker required.
 */
const dirGeneration = new Map<string, number>()

/**
 * Canonical map key for a profile dir.
 *
 * Keyed by raw string, `C:/x` and `C:\x` are two different owners of the same
 * directory — and an ownership check that silently compares the wrong key is
 * indistinguishable from no check at all. Today every caller goes through
 * `authProfileDir`, so the keys happen to agree; this stops that from being the
 * thing holding it together. Windows paths are case-insensitive too.
 */
function dirKey(profileDir: string): string {
  const k = profileDir.replace(/\\/g, '/')
  return process.platform === 'win32' ? k.toLowerCase() : k
}

/** Claim a profile dir for a new run, invalidating any retry still pending on it. */
function claimProfileDir(profileDir: string): number {
  const key = dirKey(profileDir)
  const next = (dirGeneration.get(key) ?? 0) + 1
  dirGeneration.set(key, next)
  return next
}

/**
 * Keep trying to delete a profile dir that was still locked at teardown.
 *
 * Measured on the box 2026-08-08: after `taskkill /T /F` the tree dies in ~850ms
 * and the directory becomes removable ~1.5s later — but that is one machine on
 * one day, and when the timing does not hold, what stays on disk is a live
 * `sessionKey`. `sweepAbandonedProfiles` only runs at the NEXT app start, which
 * could be days. So the window gets closed now, on a backoff, rather than being
 * left to a boot that may not come.
 */
export function retryProfileRemoval(
  profileDir: string,
  delays: readonly number[] = PROFILE_REMOVAL_RETRIES_MS,
  generation: number = dirGeneration.get(dirKey(profileDir)) ?? 0,
): void {
  const attempt = (i: number): void => {
    const t = setTimeout(() => {
      // OWNERSHIP FIRST, before any filesystem call. A newer run has claimed
      // this path, so whatever is there now belongs to it — deleting it would
      // destroy a live sign-in rather than clean up a dead one.
      if ((dirGeneration.get(dirKey(profileDir)) ?? 0) !== generation) return
      try {
        if (!existsSync(profileDir)) return
        rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
        logInfo(`[account-web] removed the sign-in profile dir on retry ${i + 1}`)
      } catch (err) {
        if (i + 1 < delays.length) return attempt(i + 1)
        logError(`[account-web] sign-in profile dir STILL not removed after ${delays.length} retries; it holds a live session and will be swept at next start: ${(err as Error)?.message}`)
      }
    }, delays[i])
    // Never hold the process open for this.
    if (typeof (t as any)?.unref === 'function') (t as any).unref()
  }
  if (delays.length) attempt(0)
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
  // ALREADY REAPED? Then signal nothing. `proc.killed` does not answer this — it
  // only says a signal was sent — so a browser the user closed themselves still
  // looked killable, and the POSIX branch below would schedule a group SIGKILL
  // against a pid the OS is free to hand to someone else two seconds later.
  // Registering the cancelling 'exit' listener afterwards cannot help: that
  // event has already fired and a late listener never runs.
  if (proc.exitCode !== null || proc.signalCode !== null) return
  if (process.platform === 'win32') {
    // /T = tree, /F = force. Windows has no process-group kill for this.
    // NOT silent on failure: a swallowed error here looks exactly like a kill
    // that worked, and the only visible symptom is an EPERM further down whose
    // cause is then unknowable. Measured working standalone on this box, so if
    // it fails from inside Electron the log needs to say so.
    try {
      const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
      if (r.error) logError(`[account-web] taskkill could not run (${r.error.message}); falling back to a direct signal`)
      else if (r.status !== 0) logError(`[account-web] taskkill exited ${r.status} for pid ${pid}`)
    } catch (err) {
      logError(`[account-web] taskkill threw: ${(err as Error)?.message}`)
    }
  }
  else {
    // POSIX: Chrome is a process tree here too, and a bare `proc.kill()` reaps
    // only the parent — exactly the bug the Windows path above was written to
    // fix. The child is spawned detached, so it leads its own process group and
    // a negative pid signals the whole group. SIGKILL follows because an
    // unresponsive browser never acts on SIGTERM, and the profile dir it is
    // holding contains a live session.
    try { process.kill(-pid, 'SIGTERM') } catch { /* no group, or already gone */ }
    // CANCELLED THE MOMENT THE CHILD IS REAPED. A blind SIGKILL fired 2s later
    // targets a pid the OS has already freed — and Chrome burns pids fast
    // enough that the number can be back in use by then, at which point this
    // group-kills an unrelated process tree. The escalation is for a browser
    // that ignored SIGTERM, not for one that obeyed it.
    const t = setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
    }, 2_000)
    if (typeof (t as any)?.unref === 'function') (t as any).unref()
    try { proc.once('exit', () => clearTimeout(t)) } catch { /* no emitter */ }
  }
  // Always signal directly too: on win32 this catches a taskkill that could not
  // run, and on POSIX it covers a child that never became a group leader.
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
    // VALIDATE THE NAME BEFORE DELETING BY IT. Every other path-bound id in this
    // module is re-checked against PROFILE_ID_RE rather than trusted, and this
    // one is a recursive delete driven by whatever names exist in a directory.
    // It runs unconditionally at every app start, so it is the last place to
    // make an exception for.
    if (!PROFILE_ID_RE.test(entry)) {
      logError(`[account-web] refusing to sweep an entry that is not a profile dir: ${entry}`)
      continue
    }
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
  /** Page title — used only to spot a Cloudflare "Just a moment..." interstitial. */
  title?: string
  id?: string
  webSocketDebuggerUrl?: string
}

/**
 * True for a URL served by claude.ai itself, over HTTPS. Anything unparseable
 * is not.
 *
 * THE SCHEME IS PART OF THE CHECK. A hostname match alone accepts
 * `http://claude.ai/`, and this browser profile is created fresh for every
 * sign-in — it carries no HSTS state of its own, so a captive portal or a
 * transparent proxy can answer plaintext on that host. The subsequent
 * origin-relative `fetch('/api/bootstrap')` would then be asking an attacker who
 * is signed in, and the answer becomes the account identity CCC stores.
 *
 * Exported so both the target filter and the in-connection re-check use exactly
 * this rule. They were two copy-pasted hostname comparisons, which is how one of
 * them silently drifts.
 */
export function isClaudeUrl(url: string | undefined): boolean {
  try {
    const u = new URL(url ?? '')
    if (u.protocol !== 'https:') return false
    const host = u.hostname.toLowerCase()
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

/**
 * Bound a CDP round-trip in time.
 *
 * NOTHING OVER CDP IS ALLOWED TO HANG. The poll loop only consults its deadline
 * at the top of each iteration, so a promise that never settles parks the loop
 * forever: `current.phase` stays in flight, the single-flight latch never
 * releases, and EVERY account's sign-in is dead until the app restarts —
 * `cancelSignIn` cannot help, because the loop is not running to observe it.
 * `Runtime.evaluate` with `awaitPromise` on an origin-relative fetch is exactly
 * the shape that stalls against a proxy that accepts the connection and then
 * says nothing.
 *
 * Rejects on timeout; every caller already treats a rejection as "no answer".
 */
async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`[account-web] ${what} timed out after ${ms}ms`)), ms)
        if (typeof (timer as any)?.unref === 'function') (timer as any).unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * How long any single blocking call in the sign-in may take.
 *
 * NOT JUST CDP. The first version of this bounded only the DevTools calls, which
 * left `cookies.set` and `clearStorageData` unbounded — and those cross
 * Electron's network-service IPC, which is if anything MORE prone to stalling
 * than a loopback websocket. A hang in either parks the poll loop just as
 * effectively and wedges every account's sign-in.
 */
const IO_CALL_TIMEOUT_MS = 10_000

/** Close a CDP client without letting a teardown error mask the real outcome. */
async function closeQuietly(client: any): Promise<void> {
  try { await withTimeout(Promise.resolve(client?.close?.()), IO_CALL_TIMEOUT_MS, 'CDP close') } catch { /* closing anyway */ }
}

/**
 * True when the connected target's own reported URL is claude.ai.
 *
 * ORIGIN GATE, AND IT RUNS NO PAGE SCRIPT. `Target.getTargetInfo` reads target
 * metadata over CDP; it does not execute anything in the document. That matters
 * because this runs on every poll while the human is still on the page, and the
 * one thing this flow must NOT do during that window is run script in the login
 * page — see readAccountEmail (#269).
 */
async function targetIsClaudeAi(client: any): Promise<boolean> {
  if (typeof client?.Target?.getTargetInfo !== 'function') return false
  try {
    const url = (await withTimeout<any>(client.Target.getTargetInfo(), IO_CALL_TIMEOUT_MS, 'getTargetInfo'))?.targetInfo?.url
    return typeof url === 'string' && isClaudeUrl(url)
  } catch {
    return false   // asked, and could not find out. Not the same as "it is fine".
  }
}

/** Cloudflare's managed-challenge surfaces, by target URL/title. Pure. */
export function isCloudflareChallenge(t: CdpTarget): boolean {
  const url = (t?.url ?? '').toLowerCase()
  const title = (t?.title ?? '').toLowerCase()
  return (
    url.includes('challenges.cloudflare.com') ||
    url.includes('/cdn-cgi/challenge-platform/') ||
    title === 'just a moment...'
  )
}

/**
 * Ask the page for the signed-in account, via claude.ai's own bootstrap.
 *
 * THE ONE CALL IN THIS FLOW THAT RUNS SCRIPT IN THE LOGIN PAGE, and #269 is why
 * it now runs at most once, only AFTER a real session cookie has appeared.
 * Cloudflare's Turnstile treats an attached debugger evaluating in the page as
 * automation and re-arms its "verify you are human" challenge indefinitely, so
 * calling this every poll (as the first version did) made the very challenge it
 * needed the user to clear un-clearable. Once the session cookie exists the
 * challenge is demonstrably already cleared, so a single evaluate here is safe.
 */
async function readAccountEmail(client: any): Promise<string | null> {
  try {
    // The fetch below is ORIGIN-RELATIVE, so it only means what we think if the
    // evaluated target is actually claude.ai. During an SSO hop the first target
    // can be the identity provider, and a page that answers with an
    // account-shaped object would otherwise label the stored session with an
    // unrelated email.
    //
    // THIS CHECK FAILS CLOSED. It used to swallow every error and fall through
    // to the fetch, which made "the page is not claude.ai" and "asking which
    // page this is failed" the same outcome — trust it. That is not theoretical:
    // the target list is re-read every poll precisely because pages come and go,
    // so `getTargetInfo` rejecting with "No target with given id found" mid
    // navigation is a NORMAL failure, and an attacker-controlled page inherits
    // the trust. Demonstrated: with `getTargetInfo` throwing, a page on
    // evil.test was accepted and its email stored as the account identity.
    //
    // The one legitimate skip is a client with no Target domain at all, which is
    // a shape question and not a runtime failure.
    // No Target domain at all is no longer an escape hatch. It was the one
    // branch that still accepted an arbitrary page's answer as the account
    // identity, and nothing legitimate needs it: a real chrome-remote-interface
    // client always carries Target.
    if (typeof client?.Target?.getTargetInfo !== 'function') return null
    let url: unknown
    try {
      url = (await withTimeout<any>(client.Target.getTargetInfo(), IO_CALL_TIMEOUT_MS, 'getTargetInfo'))?.targetInfo?.url
    } catch {
      return null   // asked, and could not find out. Not the same as "it is fine".
    }
    if (typeof url !== 'string' || !isClaudeUrl(url)) return null

    // AND CHECK AGAIN INSIDE THE PAGE. The check above is on target metadata
    // from a previous round-trip; `Runtime.evaluate` runs in whatever document
    // the frame holds NOW, and this module re-reads the target list every poll
    // precisely because pages come and go. `location.origin` is evaluated in the
    // same breath as the fetch, so the two cannot disagree.
    const { result } = await withTimeout<any>(client.Runtime.evaluate({
      expression: `location.origin === 'https://claude.ai' || location.origin === 'https://www.claude.ai' ? fetch('/api/bootstrap',{credentials:'include'}).then(r=>r.json()).then(j=>j?.account?.email_address ?? null).catch(()=>null) : Promise.resolve(null)`,
      awaitPromise: true,
      returnByValue: true,
    }), IO_CALL_TIMEOUT_MS, 'bootstrap evaluate')
    return typeof result?.value === 'string' ? result.value : null
  } catch {
    return null
  }
}

export interface RunSignInOpts {
  profileId: string
  dataDir: string
  /**
   * The account's CLI sign-in flow. Routes the web sign-in: 'sso' keeps the
   * system-browser + CDP path (its identity provider may need a policy-installed
   * browser extension an Electron window lacks); anything else signs in IN-APP
   * (no launched browser, no debug port — claude.ai's bot-detection flags that
   * port). Absent falls back to the default, which is non-SSO.
   */
  method?: CliAuthMethod
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

  // ROUTE (#265 follow-up). Non-SSO accounts sign in IN-APP — inside an Electron
  // window on this partition, with no launched browser and no debug port, so
  // claude.ai's bot-detection has nothing to flag. SSO keeps the system-browser
  // flow below (its identity provider may need a policy-installed extension an
  // Electron window does not carry). The session cookie lands in this partition
  // directly, so there is no harvest/injection and no on-disk profile to sweep.
  if ((opts.method ?? DEFAULT_CLI_AUTH_METHOD) !== 'sso') {
    current = { phase: 'awaiting-user', profileId }
    try {
      const res = await runInAppSignIn({
        profileId,
        partition,
        timeoutMs,
        pollMs,
        shouldCancel: () => cancelled,
      })
      // NON-COMPLETION IN-APP (#439 adversarial A3): the in-app window writes the
      // session cookie straight into this partition as the user signs in, so a
      // flow that ends WITHOUT a session — Cancel, the window X'd, a timeout —
      // can leave a live cookie the pane may already have recorded. `res.session`
      // is present only on a clean completion, so its absence is the signal to
      // wipe (the X button is a likelier gesture than Cancel). This is the
      // DEFAULT route for subscription accounts; the SSO branches wipe on revoke,
      // so this must too — empty the partition and forget the record + pane.
      if (!res.session) {
        try {
          await withTimeout(Promise.resolve(electronSession.fromPartition(partition).clearStorageData()), IO_CALL_TIMEOUT_MS, 'clearStorageData')
        } catch (err) {
          logError(`[account-web] could not clear a cancelled in-app session for ${profileId}: ${(err as Error)?.message ?? err}`)
        }
        notifyPartitionRevoked(profileId)
      }
      current = res.session
        ? { phase: 'done', profileId, session: res.session }
        : { phase: 'failed', profileId, error: res.error ?? (res.cancelled ? 'Sign-in cancelled.' : 'Sign-in failed.') }
    } catch (err) {
      // runInAppSignIn is contracted never to throw; this is defence-in-depth so
      // an unexpected throw still lands as a failed state and releases the
      // single-flight latch, never propagating out of runSignIn (adversarial review).
      closeInAppSignInWindow()
      current = { phase: 'failed', profileId, error: (err as Error)?.message ?? String(err) }
    }
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

    // CLAIM THE PATH before anything is created in it. `authProfileDir` is
    // deterministic per account, so a previous run's background removal may
    // still be pending on this exact directory; claiming invalidates it.
    const generation = claimProfileDir(profileDir)

    // Drop any stale DevToolsActivePort a previous run left behind. The port is
    // read back from that file to PROVE the CDP endpoint is the browser we just
    // launched, and a leftover file turns that proof into a coincidence.
    try { rmSync(join(profileDir, DEVTOOLS_PORT_FILE), { force: true }) } catch { /* nothing there */ }

    logInfo(`[account-web] launching ${bin.browser} for ${profileId} on an ephemeral loopback port`)
    // Detached on POSIX so the browser gets its own process GROUP, which is the
    // only way to reap Chrome's children there — see killBrowserTree.
    child = spawn(bin.path, args, { detached: process.platform !== 'win32', stdio: 'ignore' })
    child.on('error', (err) => logError(`[account-web] browser spawn error: ${err.message}`))
    child.on('exit', () => { browserExited = true })

    current = tag({ phase: 'awaiting-user', profileId })
    const deadline = Date.now() + timeoutMs

    // Read the port from the profile dir rather than assuming one. Only the
    // process that owns this dir writes that file, so this both discovers the
    // port and establishes the endpoint is OUR browser — a fixed port could be
    // answered by anything local that got there first.
    const port = await waitForDebugPort(profileDir, deadline, () => browserExited)
    if (port === null) {
      await cleanup(profileDir)
      current = tag({
        phase: 'failed',
        profileId,
        error: cancelled
          ? 'Sign-in cancelled.'
          // Distinguished: "it exited" and "it never answered" want different
          // things from the user, and blaming the debug port for a browser that
          // died on launch sends them looking in the wrong place.
          : browserExited
            ? 'The sign-in browser closed before it finished starting up. Try again, and if it keeps happening check whether policy or antivirus is blocking it.'
            : 'The browser did not report a debugging port. It may have been blocked from starting.',
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
      try { targets = await withTimeout(getCDP().List({ port }), IO_CALL_TIMEOUT_MS, 'target list') } catch { continue }

      // Tell the user when Cloudflare is challenging, from the target list alone
      // (no attach). Without this the challenge just looked like nothing
      // happening until the five-minute timeout blamed a closed window (#269).
      const challenge = targets.some(isCloudflareChallenge)

      for (const t of pickSignInTargets(targets)) {
        let client: any = null
        try {
          client = await withTimeout(
            getCDP()({ port, target: t.webSocketDebuggerUrl ?? t.id }),
            IO_CALL_TIMEOUT_MS,
            'CDP connect',
          )
        } catch { continue }

        // ORIGIN FIRST, THEN COOKIES, THEN — ONLY IF SIGNED IN — the identity read.
        // Reordered for #269: the old flow ran `readAccountEmail` (which executes
        // script in the page) on EVERY poll, and Cloudflare's Turnstile treats
        // that as automation and re-arms the challenge forever. Neither the origin
        // check nor the cookie read runs page script, so during the challenge this
        // loop now touches the page without ever scripting it, and the human can
        // actually clear the check.
        if (!(await targetIsClaudeAi(client))) { await closeQuietly(client); continue }
        // SOFT-FAIL, like every neighbouring await. getAllCookies runs against the
        // volatile login target on every 1.5s poll, and this file's own comments
        // (484-487, 658-663) call a mid-navigation "No target with given id found"
        // a NORMAL event — Cloudflare reloads the challenge once or twice. A bare
        // await here escaped the for-loop AND the while-loop into the outer catch,
        // which force-kills the browser and fails the sign-in: a self-inflicted
        // abort on exactly the churn #269 exists to survive. Retry next poll, and
        // close the client this iteration opened so a transient failure cannot leak
        // it either.
        let all: CdpCookie[]
        try {
          all = (await withTimeout<any>(client.Network.getAllCookies(), IO_CALL_TIMEOUT_MS, 'getAllCookies'))?.cookies ?? []
        } catch { await closeQuietly(client); continue }
        const harvest = harvestClaudeCookies(all)

        if (!harvest.hasSessionCookie) {
          // No session yet. This is where the whole Cloudflare challenge is spent,
          // and the point is that NO page script has run to get here.
          current = tag(challenge
            ? {
                phase: 'awaiting-user',
                profileId,
                notice: 'Cloudflare is verifying you are human — finish the check in the browser window. It can take a moment, and may re-appear once or twice before it clears.',
              }
            : { phase: 'awaiting-user', profileId })
          await closeQuietly(client)
          continue
        }

        // A real session cookie exists, so any challenge is already cleared. NOW
        // it is safe to run the single page-script identity read.
        current = tag({ phase: 'harvesting', profileId })
        const email = await readAccountEmail(client)
        if (!email) {
          // Have the cookie but the identity call did not answer yet — do not
          // store a session with no account. Try again next poll.
          current = tag({ phase: 'awaiting-user', profileId })
          await closeQuietly(client)
          continue
        }

        // THE WRITE IS CHECKED ON EVERY ITERATION, NOT ONCE BEFORE THE LOOP.
        // Each `cookies.set` is an await, and every await is a chance for the
        // sign-out IPC handler to run: checking once let `clearStorageData()`
        // land mid-loop, so the cookies written after it survived the sign-out.
        // The user pressed Sign out and stayed signed in.
        const revoked = (): boolean =>
          cancelled || (dirGeneration.get(dirKey(profileDir)) ?? 0) !== generation

        if (revoked()) { await closeQuietly(client); break }

        const store = electronSession.fromPartition(partition)
        let aborted = false
        for (const c of harvest.cookies) {
          if (revoked()) { aborted = true; break }
          try { await withTimeout(Promise.resolve(store.cookies.set(c)), IO_CALL_TIMEOUT_MS, 'cookies.set') } catch (err) {
            logError(`[account-web] could not set cookie ${c.name}: ${(err as Error)?.message}`)
          }
        }

        if (aborted) {
          // Partially written into a partition somebody just revoked. Clear what
          // landed and FAIL — reporting `done` here would have the IPC layer
          // save a session record for a session the user just signed out of.
          try {
            await withTimeout(Promise.resolve(store.clearStorageData()), IO_CALL_TIMEOUT_MS, 'clearStorageData')
          } catch (err) {
            // Loudly: what is left is cookies in a partition the user revoked.
            logError(`[account-web] could not clear a partially written session for ${profileId}: ${(err as Error)?.message}`)
          }
          // The pane surface (#439) may have recorded during the brief signed-in
          // window before the revoke landed — forget the record and close the
          // pane so the wipe is complete on every teardown door, not just
          // sign-out.
          notifyPartitionRevoked(profileId)
          await closeQuietly(client)
          await cleanup(profileDir)
          logInfo(`[account-web] ${profileId}: sign-in abandoned — the session was revoked while it was being collected`)
          current = tag({
            phase: 'failed',
            profileId,
            error: 'Signed out while the session was being collected, so it was discarded. Sign in again if that was not what you wanted.',
          })
          return current
        }

        await closeQuietly(client)
        await cleanup(profileDir)

        // ONE MORE CHECK, because `cleanup` is itself a wait. It races the
        // browser's exit for up to five seconds, and a sign-out landing in THAT
        // window used to leave the worst of both: the partition cleared, and
        // then `phase: 'done'` handed to the IPC layer, which saved a session
        // record for it. The panel said "signed in as ..." over an empty
        // partition, and every request under it would 401.
        if (revoked()) {
          try {
            await withTimeout(Promise.resolve(store.clearStorageData()), IO_CALL_TIMEOUT_MS, 'clearStorageData')
          } catch (err) {
            logError(`[account-web] could not clear a revoked session for ${profileId}: ${(err as Error)?.message}`)
          }
          // Same as the aborted branch: a pane recording made in the signed-in
          // window is forgotten with the partition it described.
          notifyPartitionRevoked(profileId)
          logInfo(`[account-web] ${profileId}: sign-in discarded — the session was revoked during teardown`)
          current = tag({
            phase: 'failed',
            profileId,
            error: 'Signed out while the session was being collected, so it was discarded. Sign in again if that was not what you wanted.',
          })
          return current
        }

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

/**
 * Cancel an in-flight sign-in and tear the browser down.
 *
 * SCOPED TO AN ACCOUNT when one is given. `cancelled` is module-global, so an
 * unscoped cancel from one account's row killed whichever sign-in happened to be
 * running — a cross-account denial with no attacker in it. Omitting the id still
 * cancels whatever is in flight, which is what app shutdown wants.
 */
export function cancelSignIn(profileId?: string): void {
  if (profileId && current.profileId && current.profileId !== profileId) return
  cancelled = true
  // Close the in-app sign-in window NOW, not just at the next poll: a cancel from
  // the UI (or a sign-out landing mid-sign-in) should take the window down at
  // once. No-op when the system-browser path is the one running.
  closeInAppSignInWindow()
}

/**
 * Forget one account's web session — used on account delete and on sign-out.
 *
 * Clears the WHOLE partition, not just cookies: claude.ai also leaves
 * localStorage, IndexedDB and cache behind, and "signed out" should not mean
 * "the cookie is gone but the account's data is still on disk".
 */
export async function clearWebSession(profileId: string): Promise<void> {
  // CANCEL FIRST. A sign-in for this account may be mid-poll, and it would
  // otherwise finish and write a fresh session into the partition we are about
  // to clear — the user presses Sign out and ends up signed in. There is a
  // second entry point for sign-in (the session right-click), so the two can
  // overlap without the settings panel ever disabling its own button.
  cancelSignIn(profileId)
  const store = electronSession.fromPartition(webPartitionForProfile(profileId))
  // BOUNDED, like every other IO in this module. This was the last raw await
  // left: a `clearStorageData` that never settles left the sign-out and
  // account-delete IPC calls unresolved forever, so the renderer's button stayed
  // busy with nothing to show for it.
  await withTimeout(Promise.resolve(store.clearStorageData()), IO_CALL_TIMEOUT_MS, 'clearStorageData')
  // Storage first, THEN the HTTP cache — the account partition is now a
  // long-lived claude.ai browsing surface (#439), so it accumulates cached
  // response bodies that clearStorageData does not touch; a wipe that left them
  // holds page content on disk. Same order webview-manager uses for the
  // throwaway partition. Best-effort: the storage wipe is the part that must
  // succeed.
  try {
    await withTimeout(Promise.resolve(store.clearCache()), IO_CALL_TIMEOUT_MS, 'clearCache')
  } catch (err) {
    logError(`[account-web] could not clear the HTTP cache for ${profileId}: ${(err as Error)?.message ?? err}`)
  }
  // Forget the record + close the pane ONLY after the wipe SUCCEEDED (A4): the
  // clearStorageData throw above propagates, so a failed wipe leaves the record
  // intact — the account survives to be signed out again rather than showing
  // "signed out" over a live session. The pane's own cookie-recheck guard means
  // an in-flight recording between now and here fails closed (the cookie is
  // gone), and a recording that saved just before the wipe is undone here.
  notifyPartitionRevoked(profileId)
  logInfo(`[account-web] cleared the web session for ${profileId}`)
}
