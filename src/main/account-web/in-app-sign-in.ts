/**
 * in-app-sign-in.ts — sign one account into claude.ai INSIDE an Electron window
 * on its own partition, with no launched browser and no debug port (#265 follow-up).
 *
 * WHY THIS EXISTS. The `system-browser` path (sign-in.ts) launches Chrome/Edge
 * with `--remote-debugging-port` and reads the session cookie back over CDP.
 * claude.ai's bot-detection flags that port: a browser with it open is challenged
 * indefinitely ("verify you are human" never clears), while the same browser
 * WITHOUT it signs in cleanly. Proven by a controlled A/B on the target machine.
 *
 * The fix is to stop scraping a cookie out of a foreign browser and instead let
 * the user sign in DIRECTLY in an Electron window bound to the account's
 * partition. The session cookie then lands in Electron's own store for that
 * partition — the same store the artifacts window already reads — so there is
 * nothing to harvest or inject, and no automation signal for claude.ai to catch.
 * One partition per account keeps the isolation model intact.
 *
 * The `system-browser` path is kept for SSO accounts, whose identity provider may
 * need a policy-installed browser extension an Electron window does not carry.
 *
 * SECURITY NOTES (this is credential code):
 *   - The window is sandboxed, context-isolated, no preload, no node. Permissions
 *     are denied throughout. It is destroyed the instant sign-in completes or is
 *     cancelled, so a session-bearing window never lingers.
 *   - It is an AUTH flow, so top-level https navigation is allowed (claude.ai may
 *     hop to an identity provider and back). Non-https navigation is blocked and
 *     popups are denied.
 *   - The identity read runs page script ONLY after the session cookie exists and
 *     ONLY when the frame's own origin is claude.ai — the same origin gate the
 *     CDP path used, so a captive-portal / IdP page cannot answer as the account.
 *
 * No default export (project convention).
 */

import { BrowserWindow, session as electronSession } from 'electron'
import { logError, logInfo } from '../debug-logger'
import { CLAUDE_SESSION_COOKIE, type AccountWebSession } from '../../shared/account-web-session'
import { webSessionFromElectronCookies, type ElectronReadCookie } from './cookie-harvest'

/** Upper bound on any single Electron call here, mirroring sign-in.ts. */
const IO_CALL_TIMEOUT_MS = 10_000

/**
 * PURE: turn Electron's default user-agent into a plain Chrome one by dropping
 * the two non-standard tokens Electron inserts — the ` <productName>/<ver>` that
 * precedes `Chrome/` and the ` Electron/<ver>` after it. Leaves the real platform
 * and Chrome-version tokens untouched, so claude.ai fingerprints this window like
 * the Chrome it actually is rather than flagging an "Electron" UA. Exported for a
 * unit test.
 */
export function toChromeUserAgent(ua: string): string {
  return ua
    .replace(/ Electron\/\S+/g, '')
    // Collapse everything between "(KHTML, like Gecko) " and "Chrome/" — that span
    // is the app-name token, which can contain spaces ("AI Code Conductor/2.1.0").
    .replace(/(\(KHTML, like Gecko\) ).*?(Chrome\/)/, '$1$2')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

let signInWindow: BrowserWindow | null = null

/** Close and forget the in-app sign-in window, if one is open. Idempotent. */
export function closeInAppSignInWindow(): void {
  const w = signInWindow
  signInWindow = null
  try {
    // destroy(), not close(): a page can veto close() via beforeunload, and this
    // window holds an emerging session we want gone on cancel/sign-out regardless.
    if (w && !w.isDestroyed()) w.destroy()
  } catch { /* already gone */ }
}

export interface InAppSignInArgs {
  profileId: string
  /** `persist:claude-web-<profileId>` — the caller resolves and validates it. */
  partition: string
  /** How long to wait for the human, ms. */
  timeoutMs: number
  /** Poll interval, ms. */
  pollMs?: number
  /**
   * Accept a valid session without the display email after this grace, ms. The
   * `sessionKey` cookie is the source of truth for "signed in"; the email is only
   * a label. Defaults to 4s; a test can shorten it.
   */
  emailGraceMs?: number
  /** Read the module-global cancel flag owned by sign-in.ts. */
  shouldCancel: () => boolean
}

export interface InAppSignInResult {
  ok: boolean
  session?: AccountWebSession
  error?: string
  cancelled?: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms)
    if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref()
  })
}

/** Bound any promise in time — nothing over IPC/IO is allowed to hang the poll. */
function bounded<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`[account-web] in-app ${what} timed out`)), IO_CALL_TIMEOUT_MS)
      if (typeof (timer as { unref?: () => void })?.unref === 'function') (timer as { unref: () => void }).unref()
    }),
  ]).finally(() => { if (timer) clearTimeout(timer) })
}

/**
 * Read the signed-in account email from the live window, origin-gated.
 *
 * Runs at most one script call, and ONLY the caller invokes it after a real
 * session cookie exists. The origin check is evaluated in the same breath as the
 * fetch (both read the frame's CURRENT document), so "this is claude.ai" and "ask
 * claude.ai who I am" cannot disagree — a mid-flow IdP page answers null.
 *
 * The check is trustworthy even though `executeJavaScript` runs in the page's
 * MAIN world (there is no preload, so nothing to isolate): `location` is
 * [LegacyUnforgeable] in the HTML spec — a page cannot shadow or redefine it, and
 * assigning `window.location` navigates rather than replacing the object — so
 * `location.origin` is the frame's true origin. Completion itself does not rest
 * on this at all: it is decided by the domain-scoped `sessionKey` cookie for
 * claude.ai, which a page the window roamed to cannot write for that domain.
 */
async function readAccountEmailInWindow(win: BrowserWindow): Promise<string | null> {
  if (win.isDestroyed()) return null
  const expr =
    `(location.origin === 'https://claude.ai' || location.origin === 'https://www.claude.ai') ` +
    `? fetch('/api/bootstrap',{credentials:'include'}).then(r=>r.json())` +
    `.then(j=>(j&&j.account&&j.account.email_address)||null).catch(()=>null) ` +
    `: Promise.resolve(null)`
  try {
    const v = await bounded(Promise.resolve(win.webContents.executeJavaScript(expr, true)), 'bootstrap evaluate')
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

/** True for an https URL; anything unparseable or non-https is not. */
function isHttps(url: string): boolean {
  try { return new URL(url).protocol === 'https:' } catch { return false }
}

/**
 * Drive the in-app sign-in to completion. Never throws — resolves with a result
 * the caller maps onto SignInState. The session cookie already lives in the
 * partition when this returns ok, so the caller only records metadata.
 */
export async function runInAppSignIn(args: InAppSignInArgs): Promise<InAppSignInResult> {
  const { profileId, partition, timeoutMs } = args
  const pollMs = args.pollMs ?? 1200

  const cancelledResult = (): InAppSignInResult => {
    closeInAppSignInWindow()
    return { ok: false, cancelled: true, error: 'Sign-in cancelled.' }
  }

  // NEVER-THROW contract (runSignIn depends on it, and a throw here would
  // otherwise wedge the single-flight latch for every account). Any unexpected
  // Electron error — fromPartition, window creation, a handler registration —
  // fails closed: tear down any window and report (adversarial review).
  try {
    const ses = electronSession.fromPartition(partition)
    try { ses.setUserAgent(toChromeUserAgent(ses.getUserAgent())) } catch { /* non-fatal */ }

    const win = new BrowserWindow({
      width: 1200,
      height: 860,
      title: 'Sign in to claude.ai',
      autoHideMenuBar: true,
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
      },
    })
    signInWindow = win

    // Block only NON-https top-level navigation (javascript:, file:, custom
    // schemes). https is allowed so an identity-provider hop works; the window is
    // destroyed on completion so it never lingers off-claude.ai with a session.
    const blockNonHttps = (e: { preventDefault: () => void }, url: string): void => {
      if (!isHttps(url)) e.preventDefault()
    }
    win.webContents.on('will-navigate', blockNonHttps)
    win.webContents.on('will-redirect', blockNonHttps)
    // No unhardened popups. A rare popup-based IdP is a system-browser/SSO case.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // A page has no business reaching a camera/mic/clipboard on its own say-so.
    win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))

    let windowClosed = false
    win.on('closed', () => { windowClosed = true; if (signInWindow === win) signInWindow = null })

    // loadURL can reject when the login page immediately 3xx-redirects (normal),
    // and it must not HANG: a captive portal that accepts the connection then
    // says nothing would otherwise park the poll — and single-flight with it — so
    // it is bounded like every other IO here (adversarial review).
    try { await bounded(Promise.resolve(win.loadURL('https://claude.ai/login')), 'loadURL') } catch { /* redirect or slow load */ }

    logInfo(`[account-web] in-app sign-in window opened for ${profileId}`)

    const deadline = Date.now() + timeoutMs
    // Accept a valid session without the display email after this grace — the
    // sessionKey cookie, not the bootstrap email, is the source of truth for
    // "signed in"; the email is only a label.
    const EMAIL_GRACE_MS = args.emailGraceMs ?? 4_000
    let sessionSeenAt = 0

    const closedResult = (): InAppSignInResult => ({
      ok: false,
      error: 'The sign-in window was closed before sign-in completed. Open it again and leave it up until the panel says you are signed in.',
    })

    while (Date.now() < deadline) {
      if (args.shouldCancel()) return cancelledResult()
      if (windowClosed) return closedResult()
      await sleep(pollMs)
      if (args.shouldCancel()) return cancelledResult()
      if (windowClosed) return closedResult()

      let cookies
      try {
        cookies = await bounded(Promise.resolve(ses.cookies.get({ url: 'https://claude.ai' })), 'cookies.get')
      } catch { continue }
      const { hasSessionCookie, expiresAt } = webSessionFromElectronCookies(cookies)
      if (!hasSessionCookie) { sessionSeenAt = 0; continue }
      if (!sessionSeenAt) sessionSeenAt = Date.now()

      const email = await readAccountEmailInWindow(win)
      if (email === null && Date.now() - sessionSeenAt < EMAIL_GRACE_MS) continue

      // RE-CHECK the cookie is still present: a sign-out could have cleared the
      // partition during the email read, and reporting done then would save a
      // record over an empty partition (every request under it would 401).
      if (args.shouldCancel()) return cancelledResult()
      let recheck: ElectronReadCookie[] = []
      try {
        recheck = await bounded(Promise.resolve(ses.cookies.get({ url: 'https://claude.ai', name: CLAUDE_SESSION_COOKIE })), 'cookies.recheck')
      } catch { recheck = [] }
      if (!webSessionFromElectronCookies(recheck).hasSessionCookie) { sessionSeenAt = 0; continue }

      // AND re-check cancel AFTER the recheck read. clearWebSession sets the
      // cancel flag SYNCHRONOUSLY and only THEN awaits the partition wipe, so a
      // sign-out landing during the recheck read leaves the cookie momentarily
      // present — without this, done would be recorded over a partition about to
      // be emptied. The system-browser path guards the same window after its
      // teardown (adversarial review).
      if (args.shouldCancel()) return cancelledResult()

      const session: AccountWebSession = {
        profileId,
        accountEmail: email,
        acquiredAt: Date.now(),
        expiresAt,
        origin: 'in-app',
      }
      logInfo(`[account-web] ${profileId}: signed in as ${email ?? '(email pending)'} via in-app window`)
      closeInAppSignInWindow()
      return { ok: true, session }
    }

    closeInAppSignInWindow()
    logError(`[account-web] in-app sign-in for ${profileId} timed out`)
    return { ok: false, error: 'Timed out waiting for sign-in to complete.' }
  } catch (err) {
    closeInAppSignInWindow()
    logError(`[account-web] in-app sign-in for ${profileId} failed: ${(err as Error)?.message ?? err}`)
    return { ok: false, error: (err as Error)?.message ?? 'in-app sign-in failed' }
  }
}
