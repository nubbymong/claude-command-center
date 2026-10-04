/**
 * in-app-sign-in.ts - sign one account into its web service INSIDE an Electron
 * window on its own partition, with no launched browser and no debug port
 * (#265 follow-up). claude.ai for a Claude account; chatgpt.com for a Codex
 * account (P4.6, row 58).
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
 * A Codex account has no such path: its sign-in is this window only (WP1
 * design principle 4, no credential copy).
 *
 * ONE LOOP, TWO POLICIES. Both services run the same poll (cookie, identity,
 * re-check, cancel), with what differs in a policy: the page, the cookie
 * predicate, the identity read, whether the email may be missing, and the
 * navigation rule. Claude's policy is exactly what this file always did.
 *
 * EACH RUN OWNS ITS WINDOW (a SignInWindowHandle). Claude's runs use the
 * module's default handle, so its cancel and sign-out (sign-in.ts) close
 * Claude's window and nothing else; a Codex run brings its own handle, so a
 * Claude cancel can never close a Codex window, and the reverse.
 *
 * SECURITY NOTES (this is credential code):
 *   - The window is sandboxed, context-isolated, no preload, no node. Permissions
 *     are denied throughout. It is destroyed the instant sign-in completes or is
 *     cancelled, so a session-bearing window never lingers.
 *   - Navigation. Claude's window is an AUTH flow that allows any top-level https
 *     navigation (claude.ai may hop to an identity provider and back); non-https
 *     is blocked. A Codex window allows the main frame ONLY chatgpt.com and the
 *     descriptor's listed sign-in hosts (never "any https host"); a sub-frame
 *     needs https. Popups are denied for both.
 *   - The identity read runs page script ONLY after the session cookie exists and
 *     ONLY when the frame's own origin is the service's - the origin gate is
 *     inside the expression, so a captive-portal / IdP page cannot answer as the
 *     account. A Codex sign-in completes only with BOTH the named session cookie
 *     and a valid email (fail closed: no grace without the email).
 *   - A Codex run that does not complete logs the cookie NAMES on chatgpt.com and
 *     the off-site hosts the window saw, never a value and never a query string.
 *
 * No default export (project convention).
 */

import { BrowserWindow, session as electronSession } from 'electron'
import { logError, logInfo } from '../debug-logger'
import {
  CLAUDE_SESSION_COOKIE,
  isWebServiceSignInHop,
  isWebServiceUrl,
  webServiceSessionFromCookies,
  type AccountWebSession,
  type WebServiceDescriptor,
} from '../../shared/account-web-session'
import { webSessionFromElectronCookies, type ElectronReadCookie } from './cookie-harvest'
import { readAccountEmail, readServiceAccountEmail } from './account-email-read'

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

/** One sign-in run's window, owned by that run alone. */
export interface SignInWindowHandle {
  window: BrowserWindow | null
}

/** A fresh handle for a run that must not share a window with any other. */
export function createSignInWindowHandle(): SignInWindowHandle {
  return { window: null }
}

/** Claude's claude.ai sign-in window: the default handle, so sign-in.ts's
 *  cancel and sign-out close Claude's window and only Claude's. */
const claudeSignInWindow = createSignInWindowHandle()

/** Close and forget one run's sign-in window (Claude's when none is named). Idempotent. */
export function closeInAppSignInWindow(handle: SignInWindowHandle = claudeSignInWindow): void {
  const w = handle.window
  handle.window = null
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
  /** The run's window. Omitted: Claude's own (closeInAppSignInWindow's default). */
  handle?: SignInWindowHandle
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

/** True for an https URL; anything unparseable or non-https is not. */
function isHttps(url: string): boolean {
  try { return new URL(url).protocol === 'https:' } catch { return false }
}

/**
 * PURE: may a descriptor-driven (Codex) sign-in window follow this navigation?
 * The main frame: only the service's own hosts and the listed sign-in hosts,
 * https on the default port. A sub-frame (only when the event SAYS it is one):
 * left to same-origin policy, but https only. Exported for a unit test.
 */
export function signInNavAllowed(desc: WebServiceDescriptor, url: string, isMainFrame?: boolean): boolean {
  if (isMainFrame === false) return isHttps(url)
  return isWebServiceUrl(desc, url) || isWebServiceSignInHop(desc, url)
}

type PartitionSession = ReturnType<typeof electronSession.fromPartition>
type NavEvent = { preventDefault: () => void; isMainFrame?: boolean }

/** What differs between the two services' windows. */
interface WindowPolicy {
  title: string
  signInUrl: string
  /** The poll's cookie read. A throw means "no answer this poll". */
  readSession: (ses: PartitionSession) => Promise<{ hasSessionCookie: boolean; expiresAt: number | null }>
  /** The re-check after the identity read: is the session still there? */
  recheckSession: (ses: PartitionSession) => Promise<boolean>
  readEmail: (win: BrowserWindow) => Promise<string | null>
  /** Claude: a session with no email completes after the grace. Codex: never. */
  emailOptional: boolean
  /** Install the navigation guard and the popup handler. */
  guard: (win: BrowserWindow) => void
  /** A run that did not complete (names-only diagnostic). Never throws. */
  onIncomplete?: (ses: PartitionSession) => Promise<void>
}

interface DriveArgs {
  ownerId: string
  partition: string
  timeoutMs: number
  pollMs?: number
  emailGraceMs?: number
  shouldCancel: () => boolean
  handle: SignInWindowHandle
}

type DriveResult =
  | { ok: true; email: string | null; expiresAt: number | null }
  | { ok: false; error: string; cancelled?: true }

/**
 * Drive one sign-in window to completion. Never throws - resolves with a result
 * the caller maps onto its own state. The session cookie already lives in the
 * partition when this returns ok, so the caller only records metadata.
 */
async function driveSignInWindow(policy: WindowPolicy, a: DriveArgs): Promise<DriveResult> {
  const { ownerId, partition, timeoutMs, handle } = a
  const pollMs = a.pollMs ?? 1200

  const cancelledResult = (): DriveResult => {
    closeInAppSignInWindow(handle)
    return { ok: false, cancelled: true, error: 'Sign-in cancelled.' }
  }
  const incomplete = async (ses: PartitionSession | null, r: DriveResult): Promise<DriveResult> => {
    if (ses && policy.onIncomplete) {
      try { await policy.onIncomplete(ses) } catch { /* a diagnostic never changes the outcome */ }
    }
    return r
  }

  // NEVER-THROW contract (runSignIn depends on it, and a throw here would
  // otherwise wedge the single-flight latch for every account). Any unexpected
  // Electron error — fromPartition, window creation, a handler registration —
  // fails closed: tear down any window and report (adversarial review).
  let ses: PartitionSession | null = null
  try {
    const s = electronSession.fromPartition(partition)
    ses = s
    try { s.setUserAgent(toChromeUserAgent(s.getUserAgent())) } catch { /* non-fatal */ }

    const win = new BrowserWindow({
      width: 1200,
      height: 860,
      title: policy.title,
      autoHideMenuBar: true,
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
      },
    })
    handle.window = win

    policy.guard(win)
    // A page has no business reaching a camera/mic/clipboard on its own say-so.
    win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))

    let windowClosed = false
    win.on('closed', () => { windowClosed = true; if (handle.window === win) handle.window = null })

    // loadURL can reject when the login page immediately 3xx-redirects (normal),
    // and it must not HANG: a captive portal that accepts the connection then
    // says nothing would otherwise park the poll — and single-flight with it — so
    // it is bounded like every other IO here (adversarial review).
    try { await bounded(Promise.resolve(win.loadURL(policy.signInUrl)), 'loadURL') } catch { /* redirect or slow load */ }

    logInfo(`[account-web] in-app sign-in window opened for ${ownerId}`)

    const deadline = Date.now() + timeoutMs
    // Claude: accept a valid session without the display email after this
    // grace - the sessionKey cookie, not the bootstrap email, is the source of
    // truth for "signed in"; the email is only a label.
    const EMAIL_GRACE_MS = a.emailGraceMs ?? 4_000
    let sessionSeenAt = 0

    const closedResult = (): DriveResult => ({
      ok: false,
      error: 'The sign-in window was closed before sign-in completed. Open it again and leave it up until the panel says you are signed in.',
    })

    while (Date.now() < deadline) {
      if (a.shouldCancel()) return incomplete(s, cancelledResult())
      if (windowClosed) return incomplete(s, closedResult())
      await sleep(pollMs)
      if (a.shouldCancel()) return incomplete(s, cancelledResult())
      if (windowClosed) return incomplete(s, closedResult())

      let state: { hasSessionCookie: boolean; expiresAt: number | null }
      try {
        state = await policy.readSession(s)
      } catch { continue }
      if (!state.hasSessionCookie) { sessionSeenAt = 0; continue }
      if (!sessionSeenAt) sessionSeenAt = Date.now()

      const email = await policy.readEmail(win)
      if (email === null) {
        // FAIL CLOSED where the email is required (Codex): a session cookie
        // without a valid identity answer is never "signed in".
        if (!policy.emailOptional) continue
        if (Date.now() - sessionSeenAt < EMAIL_GRACE_MS) continue
      }

      // RE-CHECK the cookie is still present: a sign-out could have cleared the
      // partition during the email read, and reporting done then would save a
      // record over an empty partition (every request under it would 401).
      if (a.shouldCancel()) return incomplete(s, cancelledResult())
      let still = false
      try { still = await policy.recheckSession(s) } catch { still = false }
      if (!still) { sessionSeenAt = 0; continue }

      // AND re-check cancel AFTER the recheck read. The clear sets the cancel
      // flag SYNCHRONOUSLY and only THEN awaits the partition wipe, so a
      // sign-out landing during the recheck read leaves the cookie momentarily
      // present — without this, done would be recorded over a partition about to
      // be emptied. The system-browser path guards the same window after its
      // teardown (adversarial review).
      if (a.shouldCancel()) return incomplete(s, cancelledResult())

      closeInAppSignInWindow(handle)
      return { ok: true, email, expiresAt: state.expiresAt }
    }

    closeInAppSignInWindow(handle)
    logError(`[account-web] in-app sign-in for ${ownerId} timed out`)
    return incomplete(s, { ok: false, error: 'Timed out waiting for sign-in to complete.' })
  } catch (err) {
    closeInAppSignInWindow(handle)
    logError(`[account-web] in-app sign-in for ${ownerId} failed: ${(err as Error)?.message ?? err}`)
    return incomplete(ses, { ok: false, error: (err as Error)?.message ?? 'in-app sign-in failed' })
  }
}

/**
 * Claude's claude.ai window policy: exactly what this window always did.
 *
 * The email is read through the SHARED reader (account-email-read): an ISOLATED
 * world so page script cannot shadow the wrapper (`Promise.resolve` overriding
 * was the injection this closes - #439 adversarial A2), plus shape/length
 * validation on the result. The origin gate inside the expression is the
 * load-bearing check either way (`location` is [LegacyUnforgeable]); completion
 * rests on the domain-scoped `sessionKey` cookie, which a roamed page cannot write.
 */
const CLAUDE_WINDOW_POLICY: WindowPolicy = {
  title: 'Sign in to claude.ai',
  signInUrl: 'https://claude.ai/login',
  readSession: async (ses) => webSessionFromElectronCookies(
    await bounded(Promise.resolve(ses.cookies.get({ url: 'https://claude.ai' })), 'cookies.get'),
  ),
  recheckSession: async (ses) => {
    let recheck: ElectronReadCookie[] = []
    try {
      recheck = await bounded(Promise.resolve(ses.cookies.get({ url: 'https://claude.ai', name: CLAUDE_SESSION_COOKIE })), 'cookies.recheck')
    } catch { recheck = [] }
    return webSessionFromElectronCookies(recheck).hasSessionCookie
  },
  readEmail: async (win) => {
    if (win.isDestroyed()) return null
    try {
      return await bounded(readAccountEmail(win.webContents), 'bootstrap evaluate')
    } catch {
      return null
    }
  },
  emailOptional: true,
  guard: (win) => {
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
  },
}

/**
 * Drive the in-app claude.ai sign-in to completion. Never throws - resolves with
 * a result the caller maps onto SignInState. The session cookie already lives in
 * the partition when this returns ok, so the caller only records metadata.
 */
export async function runInAppSignIn(args: InAppSignInArgs): Promise<InAppSignInResult> {
  const { profileId } = args
  const r = await driveSignInWindow(CLAUDE_WINDOW_POLICY, {
    ownerId: profileId,
    partition: args.partition,
    timeoutMs: args.timeoutMs,
    pollMs: args.pollMs,
    emailGraceMs: args.emailGraceMs,
    shouldCancel: args.shouldCancel,
    handle: args.handle ?? claudeSignInWindow,
  })
  if (!r.ok) return r.cancelled ? { ok: false, cancelled: true, error: r.error } : { ok: false, error: r.error }
  const session: AccountWebSession = {
    profileId,
    accountEmail: r.email,
    acquiredAt: Date.now(),
    expiresAt: r.expiresAt,
    origin: 'in-app',
  }
  logInfo(`[account-web] ${profileId}: signed in as ${r.email ?? '(email pending)'} via in-app window`)
  return { ok: true, session }
}

// ---- a descriptor-driven sign-in (chatgpt.com for a Codex account) --------

/** At most this many cookie names and off-site hosts go into one diagnostic line. */
const DIAG_MAX_NAMES = 40
const DIAG_MAX_HOSTS = 20

/** A cookie NAME fit for a log line, or null (dropped, and counted). */
function diagCookieName(name: unknown): string | null {
  return typeof name === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(name) ? name : null
}

/** The host of a URL fit for a log line (never a path, query or fragment). */
function diagHost(url: string): string {
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    if (host && /^[a-z0-9.-]{1,253}$/.test(host)) return u.port ? `${host}:${u.port}` : host
    if (host) return '(unprintable host)'
    return /^[a-z][a-z0-9+.-]{0,20}:$/.test(u.protocol) ? u.protocol : '(no host)'
  } catch {
    return '(unparseable)'
  }
}

/** What one descriptor-driven run saw: off-site hosts only, in first-seen order. */
class SignInDiagnostic {
  private readonly seen = new Set<string>()
  private readonly entries: string[] = []
  private dropped = 0
  constructor(private readonly desc: WebServiceDescriptor) {}
  private note(entry: string): void {
    if (this.seen.has(entry)) return
    if (this.entries.length >= DIAG_MAX_HOSTS) { this.dropped++; return }
    this.seen.add(entry)
    this.entries.push(entry)
  }
  hop(url: string, allowed: boolean): void {
    if (isWebServiceUrl(this.desc, url)) return
    this.note(`${diagHost(url)} (${allowed ? 'allowed' : 'blocked'})`)
  }
  popup(url: string): void {
    this.note(`${diagHost(url)} (popup denied)`)
  }
  hosts(): string {
    if (!this.entries.length) return 'none'
    return this.entries.join(', ') + (this.dropped ? `, and ${this.dropped} more` : '')
  }
}

function serviceWindowPolicy(desc: WebServiceDescriptor, ownerId: string): WindowPolicy {
  const diag = new SignInDiagnostic(desc)
  const readJar = async (ses: PartitionSession, what: string) =>
    bounded(Promise.resolve(ses.cookies.get({ url: desc.origin })), what)
  return {
    title: `Sign in to ${desc.label}`,
    signInUrl: desc.signInUrl,
    readSession: async (ses) => webServiceSessionFromCookies(desc, await readJar(ses, 'cookies.get')),
    recheckSession: async (ses) => webServiceSessionFromCookies(desc, await readJar(ses, 'cookies.recheck')).hasSessionCookie,
    readEmail: async (win) => {
      if (win.isDestroyed()) return null
      try {
        return await bounded(readServiceAccountEmail(win.webContents, desc), 'identity read')
      } catch {
        return null
      }
    },
    emailOptional: false,
    guard: (win) => {
      const onNav = (e: NavEvent, url: string): void => {
        const allowed = signInNavAllowed(desc, url, e?.isMainFrame)
        if (e?.isMainFrame !== false) diag.hop(url, allowed)
        if (!allowed) e.preventDefault()
      }
      win.webContents.on('will-navigate', onNav)
      win.webContents.on('will-redirect', onNav)
      // Popups denied. If the owner's run shows a sign-in method needs one, it
      // gets a scoped allowance of its own (and its own adversarial pass).
      win.webContents.setWindowOpenHandler(({ url }) => {
        diag.popup(url)
        return { action: 'deny' }
      })
    },
    onIncomplete: async (ses) => {
      let names: string[] = []
      let unprintable = 0
      try {
        const jar = await readJar(ses, 'cookies.names')
        for (const c of jar ?? []) {
          const n = diagCookieName((c as { name?: unknown })?.name)
          if (n === null) unprintable++
          else if (!names.includes(n)) names.push(n)
        }
      } catch {
        names = []
      }
      const shown = names.slice(0, DIAG_MAX_NAMES)
      const more = names.length - shown.length + unprintable
      logInfo(
        `[codex-web] sign-in for ${ownerId} did not complete. Cookie names on ${desc.origin}: `
        + `${shown.length ? shown.join(', ') : 'none'}${more ? ` (and ${more} not shown)` : ''}. `
        + `Off-site hosts: ${diag.hosts()}.`,
      )
    },
  }
}

export interface ServiceSignInArgs {
  service: WebServiceDescriptor
  /** The account the run is for (logs only). */
  ownerId: string
  /** The account's partition - the caller resolves and validates it. */
  partition: string
  /** This run's own window; never shared with another run. */
  handle: SignInWindowHandle
  timeoutMs: number
  pollMs?: number
  /** The email grace a service with an optional email would allow. A
   *  descriptor-driven service requires the email, so this changes nothing;
   *  a test sets it to 0 to prove completion still waits for the email. */
  emailGraceMs?: number
  shouldCancel: () => boolean
}

export interface ServiceSignInResult {
  ok: boolean
  /** On ok: the validated email (completion requires it). */
  email?: string
  /** On ok: the session cookie's expiry, epoch ms; null for a session cookie. */
  expiresAt?: number | null
  cancelled?: boolean
  error?: string
}

/**
 * Drive a descriptor-driven sign-in window (chatgpt.com for a Codex account) to
 * completion: the named session cookie AND a valid email, re-checked, then the
 * cancel flag. Never throws. A run that does not complete logs a names-only
 * diagnostic; the caller wipes the partition.
 */
export async function runServiceSignIn(args: ServiceSignInArgs): Promise<ServiceSignInResult> {
  const r = await driveSignInWindow(serviceWindowPolicy(args.service, args.ownerId), {
    ownerId: args.ownerId,
    partition: args.partition,
    timeoutMs: args.timeoutMs,
    pollMs: args.pollMs,
    emailGraceMs: args.emailGraceMs,
    shouldCancel: args.shouldCancel,
    handle: args.handle,
  })
  if (!r.ok) return r.cancelled ? { ok: false, cancelled: true, error: r.error } : { ok: false, error: r.error }
  // emailOptional is false for every descriptor-driven policy, so a null email
  // cannot reach here; checked again rather than assumed.
  if (r.email === null) return { ok: false, error: 'The sign-in did not report an account email.' }
  logInfo(`[codex-web] ${args.ownerId}: signed in to ${args.service.label} via the sign-in window`)
  return { ok: true, email: r.email, expiresAt: r.expiresAt }
}
