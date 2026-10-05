/**
 * account-pane.ts — the browser pane's ACCOUNT surface (#439/#475): a
 * service-only WebContentsView bound to one account's cookie partition,
 * hosted inside the app's browser pane rectangle. claude.ai for a Claude
 * account; chatgpt.com for a Codex account (WP2 PR 4, P4.6, row 58).
 *
 * WHY A SEPARATE MODULE, not a mode of webview-manager: the ordinary pane view
 * loads whatever the user types, on a per-session throwaway partition that is
 * wiped when the tile closes. This view is the OPPOSITE trust domain — it rides
 * the account's partition (`persist:claude-web-<profileId>` or
 * `persist:codex-web-<acct id>`), the partition holding the account's live web
 * session (the same one its sign-in window uses). The two views must never
 * share code paths that could hand the account partition an arbitrary URL: the
 * pane's address bar, favourites, home and page-commands all write to
 * webview-manager and cannot reach this module. Mutual exclusion (one of the
 * two views per session) is enforced at the IPC handler layer, which owns both
 * modules.
 *
 * NAVIGATION POLICY (pure and unit-tested). `authed` is TRI-STATE and the
 * policy FAILS CLOSED on the unknown. Claude (accountPaneNavDecision):
 *   - claude.ai / www.claude.ai over https (default port only): allowed, always.
 *   - other https, top level, ONLY when we have positively confirmed the
 *     partition holds NO session cookie (authed === false): allowed — an SSO
 *     sign-in hops to an identity provider and back, as the in-app window permits.
 *   - other https once SIGNED IN (authed === true): blocked in-view and handed
 *     to the user's real browser — a session-bearing view must not roam.
 *   - other https while the cookie state is UNKNOWN (authed === null: first read
 *     in flight, or a read that FAILED): blocked. A rejected cookie read must not
 *     silently open the off-site door with a live session possibly present.
 *   - anything non-https: blocked outright.
 * Codex (codexPaneNavDecision) differs in ONE rule, on purpose: confirmed
 * signed out allows only the descriptor's listed sign-in hosts, never any other
 * https host. The session cookie name is not verified yet; if it is wrong, a
 * signed-in view reads as signed out, and Claude's rule would then let a
 * session-bearing chatgpt.com view roam anywhere. With the list, a wrong guess
 * widens navigation at most to those hosts.
 *
 * SIGN-IN RECORDING: when the partition transitions to holding a session
 * cookie while this view is open, the account's web-session record is saved
 * (origin 'in-pane') via the same cookie-shape helper the window flows use —
 * the cookie itself never leaves the partition; only metadata is written. A
 * Codex record needs a valid email from the identity read (fail closed).
 *
 * No default export (project convention).
 */

import { BrowserWindow, WebContentsView, session as electronSession } from 'electron'
import { logError, logInfo } from '../debug-logger'
import { IPC } from '../../shared/ipc-channels'
import {
  webPartitionForProfile,
  webPartitionForCodexAccount,
  CLAUDE_SESSION_COOKIE,
  CODEX_WEB_SERVICE,
  isWebServiceSignInHop,
  isWebServiceUrl,
  webServiceSessionFromCookies,
  type AccountPaneStateView,
} from '../../shared/account-web-session'
import { safeExternalHttpsHref } from '../../shared/safe-url'
import { shell } from 'electron'
import type { WebviewNavState } from '../../shared/browser-url'
import { webSessionFromElectronCookies } from './cookie-harvest'
import { blockPartitionDownloads, diagHost, subFrameNavAllowed, toChromeUserAgent } from './in-app-sign-in'
import { clearCodexWebSession } from './codex-web-session'
import { readAccountEmail, readServiceAccountEmail } from './account-email-read'
import { getWebSession, saveWebSession, removeWebSession } from './session-store'
import { getCodexWebSession, saveCodexWebSession, removeCodexWebSession } from './codex-web-store'
import { attachPaneView, detachPaneView } from '../pane-slot'

/** Where the account surface starts: the account's artifacts. claude.ai
 *  redirects an unauthenticated visit to its login page by itself. */
export const ACCOUNT_PANE_START_URL = 'https://claude.ai/artifacts'

const CLAUDE_HOSTS = new Set(['claude.ai', 'www.claude.ai'])

export type AccountPaneNavDecision = 'allow' | 'block' | 'external'

/** True for a URL that is https, on claude.ai / www.claude.ai, default port. */
export function isClaudePaneUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:') return false
  // Reject an explicit port: real claude.ai is 443 (u.port === ''). A
  // `claude.ai:8443` is not the service and must not be treated as it.
  if (u.port !== '') return false
  // Strip a single trailing dot (fully-qualified form) so a genuine
  // `claude.ai.` is recognised rather than handed to the off-site rules.
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  return CLAUDE_HOSTS.has(host)
}

/**
 * PURE: what to do with a top-level navigation in the account view.
 *
 * `authed` is TRI-STATE: true (confirmed session cookie), false (confirmed
 * none), null (unknown — first read in flight, or a read that failed). The
 * off-site decision fails CLOSED on null: only a POSITIVELY-confirmed
 * signed-out state opens the IdP-hop door.
 */
export function accountPaneNavDecision(url: string, authed: boolean | null): AccountPaneNavDecision {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'block'
  }
  if (u.protocol !== 'https:') return 'block'
  if (isClaudePaneUrl(url)) return 'allow'
  // Off-site https. Only a confirmed-signed-out partition may roam in-view
  // (the SSO IdP hop); a signed-in view hands the link to the real browser;
  // an UNKNOWN state blocks — a failed/racing cookie read must never open the
  // door with a live session possibly present.
  if (authed === false) return 'allow'
  if (authed === true) return 'external'
  return 'block'
}

/**
 * PURE: the same decision for a Codex account's chatgpt.com view. One rule
 * differs from Claude's: confirmed signed out (authed === false) allows ONLY
 * the listed sign-in hosts, and blocks every other https host (never "any
 * https host"). Signed in sends any off-site https to the real browser, the
 * sign-in hosts included; unknown blocks every off-site host.
 */
export function codexPaneNavDecision(url: string, authed: boolean | null): AccountPaneNavDecision {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'block'
  }
  if (u.protocol !== 'https:') return 'block'
  if (isWebServiceUrl(CODEX_WEB_SERVICE, url)) return 'allow'
  if (authed === true) return 'external'
  if (authed === false && isWebServiceSignInHop(CODEX_WEB_SERVICE, url)) return 'allow'
  return 'block'
}

export interface AccountPaneBounds {
  x: number
  y: number
  width: number
  height: number
}

/** What the renderer needs to draw the account strip: a Claude profile's
 *  claude.ai surface, or a Codex account's chatgpt.com one (shared with the
 *  preload and the renderer). */
export type AccountPaneState = AccountPaneStateView

/** A stored record, as this module reads it (either service's). */
interface StoredRecord {
  accountEmail: string | null
  acquiredAt: number
  origin: string
}

/** What differs between the two services' account views. */
interface PaneService {
  label: string
  startUrl: string
  /** The account's partition. Throws on an id of the wrong class. */
  partition: (ownerId: string) => string
  isServiceUrl: (url: string) => boolean
  navDecision: (url: string, authed: boolean | null) => AccountPaneNavDecision
  isSessionCookieName: (name: string) => boolean
  readAuth: (ses: ReturnType<typeof electronSession.fromPartition>) => Promise<{ hasSessionCookie: boolean; expiresAt: number | null }>
  recheck: (ses: ReturnType<typeof electronSession.fromPartition>) => Promise<boolean>
  readEmail: (view: WebContentsView) => Promise<string | null>
  /** A record is only made with a valid email (Codex: fail closed). */
  emailRequired: boolean
  stored: (ownerId: string) => StoredRecord | undefined
  /** Write the record; `false` means it was not written. */
  save: (ownerId: string, email: string | null, expiresAt: number | null, prior: StoredRecord | undefined) => boolean | void
  remove: (ownerId: string) => boolean | void
  /** A session the pane saw signed in whose record could not be saved: clear
   *  it, as the sign-in window's path does, so nothing stays signed in with no
   *  record (and no Sign out). Absent: the session stays (Claude's). */
  recordFailed?: (ownerId: string) => void
  stateOf: (sessionId: string, ownerId: string, authed: boolean | null, email: string | null) => AccountPaneState
}

const CLAUDE_PANE: PaneService = {
  label: 'claude.ai',
  startUrl: ACCOUNT_PANE_START_URL,
  partition: (id) => webPartitionForProfile(id),
  isServiceUrl: isClaudePaneUrl,
  navDecision: accountPaneNavDecision,
  isSessionCookieName: (name) => name === CLAUDE_SESSION_COOKIE,
  readAuth: async (ses) => webSessionFromElectronCookies(await ses.cookies.get({ url: 'https://claude.ai' })),
  recheck: async (ses) => webSessionFromElectronCookies(await ses.cookies.get({ url: 'https://claude.ai', name: CLAUDE_SESSION_COOKIE })).hasSessionCookie,
  readEmail: (view) => readAccountEmail(view.webContents as never),
  emailRequired: false,
  stored: (id) => getWebSession(id),
  save: (id, email, expiresAt, prior) => saveWebSession({
    profileId: id,
    accountEmail: email,
    acquiredAt: prior?.acquiredAt ?? Date.now(),
    expiresAt,
    origin: 'in-pane',
  }),
  remove: (id) => removeWebSession(id),
  stateOf: (sessionId, id, authed, email) => ({ sessionId, profileId: id, authed, email }),
}

const CODEX_PANE: PaneService = {
  label: CODEX_WEB_SERVICE.label,
  startUrl: CODEX_WEB_SERVICE.startUrl,
  partition: (id) => webPartitionForCodexAccount(id),
  isServiceUrl: (url) => isWebServiceUrl(CODEX_WEB_SERVICE, url),
  navDecision: codexPaneNavDecision,
  isSessionCookieName: (name) => CODEX_WEB_SERVICE.sessionCookieNames.includes(name),
  readAuth: async (ses) => webServiceSessionFromCookies(CODEX_WEB_SERVICE, await ses.cookies.get({ url: CODEX_WEB_SERVICE.origin })),
  recheck: async (ses) => webServiceSessionFromCookies(CODEX_WEB_SERVICE, await ses.cookies.get({ url: CODEX_WEB_SERVICE.origin })).hasSessionCookie,
  readEmail: (view) => readServiceAccountEmail(view.webContents as never, CODEX_WEB_SERVICE),
  emailRequired: true,
  stored: (id) => getCodexWebSession(id),
  save: (id, email, expiresAt, prior) => {
    if (email === null) return false
    return saveCodexWebSession({ accountId: id, accountEmail: email, acquiredAt: prior?.acquiredAt ?? Date.now(), expiresAt, origin: 'in-pane' })
  },
  remove: (id) => removeCodexWebSession(id),
  recordFailed: (id) => {
    void clearCodexWebSession(id).catch((err) => {
      logError(`[account-pane] could not clear the unrecorded chatgpt.com session of ${id}: ${(err as Error)?.message ?? err}`)
    })
  },
  stateOf: (sessionId, id, authed, email) => ({ sessionId, service: 'codex', accountId: id, authed, email }),
}

interface PaneEntry {
  view: WebContentsView
  svc: PaneService
  /** The Claude profile id or the Codex registry account id. */
  ownerId: string
  attachedTo: BrowserWindow
  /** Latest known cookie state; null until the first read lands. */
  authed: boolean | null
  /** Stop the partition cookie listener. */
  unsubscribeCookies: () => void
  /** Guards the once-per-transition recording. */
  recording: boolean
  /** A cookie-change arriving while a recording was in flight: re-run once the
   *  latch releases so a concurrent update is not lost. */
  recordDirty: boolean
  /** The null-email backfill has run once for this pane — don't re-poll
   *  the identity read on every navigation for an account that never yields one. */
  backfilled: boolean
  /** Where the email is required (Codex): recording attempts that found the
   *  session but no email yet. Later refreshes retry, up to a bound. */
  emailRetries: number
  /** Monotonic token for the async cookie read: a slower earlier read that
   *  resolves after a newer one must not overwrite the newer result (A8). */
  authSeq: number
  /** Trailing-debounce timer coalescing refreshAuthed bursts (A6). */
  refreshTimer: ReturnType<typeof setTimeout> | null
  /** Set by closeAccountPane: an in-flight recording must not write after the
   *  pane (or the whole web session, on sign-out) is gone. */
  closed: boolean
}

const panes = new Map<string, PaneEntry>()

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

function sendState(entry: PaneEntry, sessionId: string): void {
  try {
    // A recording that resolves after the pane closed must not push a stale
    // "signed in" state behind the PANE_CLOSED the renderer already got.
    if (entry.closed || entry.attachedTo.isDestroyed()) return
    const state = entry.svc.stateOf(sessionId, entry.ownerId, entry.authed, entry.svc.stored(entry.ownerId)?.accountEmail ?? null)
    entry.attachedTo.webContents.send(IPC.ACCOUNT_WEB_PANE_STATE, state)
  } catch { /* window gone */ }
}

/** An Electron load error's code (`ERR_ABORTED -3`), never its message: that
 *  carries the whole URL, and a URL's query can hold an OAuth code. */
function loadErrorCode(err: unknown): string {
  const code = (err as { code?: unknown })?.code
  const errno = (err as { errno?: unknown })?.errno
  const c = typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'error'
  return typeof errno === 'number' && Number.isInteger(errno) ? `${c} ${errno}` : c
}

/** Load a URL into a view. A failure is logged by host and error code, never
 *  the URL, and never rejects unhandled. */
function loadQuietly(wc: { loadURL: (url: string) => Promise<void> }, url: string, what: string): void {
  const report = (err: unknown): void => {
    logError(`[account-pane] ${what} could not load ${diagHost(url)} (${loadErrorCode(err)})`)
  }
  try {
    Promise.resolve(wc.loadURL(url)).catch(report)
  } catch (err) {
    report(err)
  }
}

/** Tell the renderer the account surface is gone (main force-closed it —
 *  sign-out, account delete, a crash). The renderer leaves account mode; without
 *  this the strip would keep painting "signed in as …" over an empty rectangle. */
function notifyPaneClosed(parent: BrowserWindow, sessionId: string, reason?: string): void {
  try {
    if (!parent.isDestroyed()) parent.webContents.send(IPC.ACCOUNT_WEB_PANE_CLOSED, reason ? { sessionId, reason } : { sessionId })
  } catch { /* window gone */ }
}

function emitNav(entry: PaneEntry, sessionId: string, loading: boolean): void {
  try {
    if (entry.attachedTo.isDestroyed()) return
    const wc = entry.view.webContents
    const state: WebviewNavState = {
      sessionId,
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      loading,
    }
    entry.attachedTo.webContents.send(IPC.WEBVIEW_NAVIGATED, state)
  } catch { /* view or window gone */ }
}

/** The view is currently on its service - a precondition for trusting anything
 *  the page tells us (the email) OR recording a session against it. */
function viewIsOnService(entry: PaneEntry): boolean {
  try {
    return entry.svc.isServiceUrl(entry.view.webContents.getURL())
  } catch {
    return false
  }
}

/** Same grace the in-app sign-in window gives the email read: the session
 *  cookie lands mid-redirect, before the document is back on the service, and
 *  the origin-gated read answers null until it is. */
const EMAIL_GRACE_MS = 4_000
const EMAIL_POLL_MS = 800
/** Where the email is required: recording attempts per pane before it stops
 *  trying (each attempt reads within one email grace). */
const MAX_EMAIL_RETRIES = 5

/**
 * The partition just transitioned to signed-in while the pane was open (or was
 * already signed in with no record on file): persist the metadata record so the
 * rest of the app — pills, artifacts gating — sees the session. Cookie stays in
 * the partition; this writes metadata only, exactly like the window flows.
 *
 * Two guards mirror in-app-sign-in's (adversarial history there): the email is
 * retried under a short grace rather than read once mid-redirect, and the write
 * is refused after the pane closed AND unless the cookie is still present — a
 * sign-out landing during the read must not save a record over a partition that
 * was just emptied (every request under it would 401).
 */
async function recordSession(entry: PaneEntry, expiresAt: number | null): Promise<void> {
  if (entry.recording) { entry.recordDirty = true; return }
  entry.recording = true
  try {
    // The email is only trustworthy when the VIEW is actually on its service:
    // a page reached via any nav gap (or one the pane happens to be parked on
    // when a sign-in completes in another surface) must never answer as the
    // account. This gates the write itself, not just the read.
    const deadline = Date.now() + EMAIL_GRACE_MS
    let email = viewIsOnService(entry) ? await entry.svc.readEmail(entry.view) : null
    while (email === null && Date.now() < deadline && !entry.closed) {
      await new Promise((r) => setTimeout(r, EMAIL_POLL_MS))
      if (entry.closed) break
      if (viewIsOnService(entry)) email = await entry.svc.readEmail(entry.view)
    }
    if (entry.closed) return
    let still: boolean
    try {
      const ses = electronSession.fromPartition(entry.svc.partition(entry.ownerId))
      still = await entry.svc.recheck(ses)
    } catch {
      return
    }
    if (!still || entry.closed) return
    // A sign-in the user CANCELS wipes the partition and then forgets the record
    // + closes this pane (the clear / the sign-in revoke cleanup both close the
    // account's panes, which sets entry.closed). So the guards above catch a
    // cancel that lands before/during this write; a cancel that lands just
    // AFTER is undone by the wipe path removing the record. No cross-import
    // into sign-in.ts is needed (it would cycle).
    // Never clobber a good record (a window flow's, or an earlier pane one that
    // captured the email) with a null-email one; and where the email is
    // required (Codex), never record without one at all.
    const prior = entry.svc.stored(entry.ownerId)
    if (email === null && entry.svc.emailRequired) {
      // No email yet where one is required: nothing is recorded, and a later
      // refresh of this pane tries again (bounded per pane), since the email
      // can arrive after this attempt's grace.
      entry.emailRetries++
      return
    }
    if (email === null && prior && prior.accountEmail) { entry.backfilled = true; return }
    if (entry.svc.save(entry.ownerId, email, expiresAt, prior) === false) {
      logError(`[account-pane] the ${entry.svc.label} record for ${entry.ownerId} could not be written`)
      try { entry.svc.recordFailed?.(entry.ownerId) } catch { /* the clear reports its own failure */ }
      return
    }
    // Bound the null-email backfill: a full grace attempt has now run for this
    // pane, so don't re-poll the identity read on every future navigation for
    // an account whose identity never yields an email (A5). A real email
    // arriving later still updates via the ordinary false->true path on the
    // next open.
    entry.backfilled = true
    logInfo(`[account-pane] recorded ${entry.svc.label} session for ${entry.ownerId} (signed in via the pane)`)
  } catch (err) {
    logError(`[account-pane] could not record session: ${(err as Error)?.message ?? err}`)
  } finally {
    entry.recording = false
    if (entry.recordDirty && !entry.closed) {
      entry.recordDirty = false
      void recordSession(entry, expiresAt)
    }
  }
}

const REFRESH_DEBOUNCE_MS = 250

/** Coalesce refreshAuthed bursts: a page firing rapid in-page navigations must
 *  not cost one main-process cookie read + record-file read each (A6). */
function scheduleRefreshAuthed(sessionId: string): void {
  const entry = panes.get(sessionId)
  if (!entry || entry.closed) return
  if (entry.refreshTimer) return
  entry.refreshTimer = setTimeout(() => {
    entry.refreshTimer = null
    void refreshAuthed(sessionId)
  }, REFRESH_DEBOUNCE_MS)
  if (typeof (entry.refreshTimer as { unref?: () => void }).unref === 'function') {
    (entry.refreshTimer as { unref: () => void }).unref()
  }
}

/** Re-read the partition's cookie state; on unauthed->authed, record. */
async function refreshAuthed(sessionId: string): Promise<void> {
  const entry = panes.get(sessionId)
  if (!entry) return
  // A8: token this read so a slower earlier one cannot clobber a newer result.
  const seq = ++entry.authSeq
  let auth: { hasSessionCookie: boolean; expiresAt: number | null }
  try {
    const ses = electronSession.fromPartition(entry.svc.partition(entry.ownerId))
    auth = await entry.svc.readAuth(ses)
  } catch {
    // A read we could not complete leaves the cookie state UNKNOWN, not "as it
    // was": pin it to null so the nav policy fails closed (off-site blocked)
    // rather than trusting a possibly-stale `false` with a live session. The
    // next cookie-change / navigation re-reads.
    if (entry.authSeq !== seq || entry.closed) return
    const before = entry.authed
    entry.authed = null
    if (before !== null) sendState(entry, sessionId)
    return
  }
  // A newer read superseded this one (or the pane closed) while awaiting.
  if (entry.authSeq !== seq || entry.closed) return
  const { hasSessionCookie, expiresAt } = auth
  const before = entry.authed
  entry.authed = hasSessionCookie
  // A1: a signed-in view must never sit OFF its service (an IdP hop / open-redirect
  // / link the pre-auth rule allowed), under chrome that says "signed in". Recall
  // it to the account start page whenever the partition is live and the view is
  // off-site — NOT gated on the false->true edge: the cookie can land while a
  // renderer-initiated nav to the attacker origin is still pending, so getURL()
  // reads the last-committed service URL at the edge and only goes off-site on
  // the later commit. `!viewIsOnService` alone terminates (once back on the
  // service it stops firing), so there is no loop.
  if (hasSessionCookie && !viewIsOnService(entry)) {
    loadQuietly(entry.view.webContents, entry.svc.startUrl, 'the return to the start page')
  }
  const stored = entry.svc.stored(entry.ownerId)
  if (
    hasSessionCookie &&
    (before === false ||
      (before === null && !stored) ||
      // Email backfill: an earlier pane recording that beat the redirect can
      // hold a null email; a later navigation (now on the service) is the
      // moment the origin-gated read can finally answer. Once-per-pane
      // (backfilled) so an account whose identity never yields an email does
      // not re-poll on every navigation. Only our own pane records - the window
      // flows manage their own.
      (stored?.origin === 'in-pane' && stored.accountEmail === null && !entry.backfilled) ||
      // Where the email is required (Codex) and an earlier attempt found the
      // session but no email yet: retry on a later refresh, a bounded number
      // of times per pane, so an email that arrives late is still recorded.
      (entry.svc.emailRequired && !stored && entry.emailRetries > 0 && entry.emailRetries < MAX_EMAIL_RETRIES))
  ) {
    void recordSession(entry, expiresAt).then(() => sendState(entry, sessionId))
  }
  // A confirmed sign-out observed in the pane (true -> false) forgets the
  // record: an in-page logout clears the cookie, and leaving a stored
  // "active" session behind would show a green dot for a session that 401s.
  if (before === true && !hasSessionCookie && entry.svc.stored(entry.ownerId)) {
    if (entry.svc.remove(entry.ownerId) === false) logError(`[account-pane] the ${entry.svc.label} record for ${entry.ownerId} could not be removed`)
  }
  if (before !== entry.authed) sendState(entry, sessionId)
}

/**
 * Open (or refocus) the claude.ai account surface for one session's pane.
 *
 * The caller (IPC handler layer) has already validated both ids and closed the
 * session's ORDINARY pane view — the two must never be attached together.
 */
export function openAccountPane(
  parent: BrowserWindow,
  sessionId: string,
  profileId: string,
  bounds: AccountPaneBounds,
): { ok: boolean; error?: string } {
  return openPane(parent, sessionId, CLAUDE_PANE, profileId, bounds)
}

/**
 * Open (or refocus) a Codex account's chatgpt.com surface for one session's
 * pane. The caller (codex-web-handlers) has already confirmed from the
 * registry that the account is a known, non-archived Codex account, and closed
 * the session's ordinary view; the account id is re-validated here as it
 * builds the partition name.
 */
export function openCodexAccountPane(
  parent: BrowserWindow,
  sessionId: string,
  accountId: string,
  bounds: AccountPaneBounds,
): { ok: boolean; error?: string } {
  return openPane(parent, sessionId, CODEX_PANE, accountId, bounds)
}

function openPane(
  parent: BrowserWindow,
  sessionId: string,
  svc: PaneService,
  ownerId: string,
  bounds: AccountPaneBounds,
): { ok: boolean; error?: string } {
  if (!SESSION_ID_RE.test(sessionId)) return { ok: false, error: 'session id is not path-safe' }
  let partition: string
  try {
    partition = svc.partition(ownerId)
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? 'invalid account' }
  }

  const existing = panes.get(sessionId)
  if (existing) {
    // Reuse only when it is the SAME account (and service) AND still parented
    // to THIS window and alive. A different account, a different window (the
    // old host closed and a new one opened), or a dead view all fall through to
    // a rebuild - otherwise a reopen returns ok over a view attached to a gone
    // window.
    const reusable =
      existing.svc === svc &&
      existing.ownerId === ownerId &&
      existing.attachedTo === parent &&
      !parent.isDestroyed() &&
      !existing.view.webContents.isDestroyed()
    if (reusable) {
      try { existing.view.setBounds(bounds) } catch { /* view gone */ }
      return { ok: true }
    }
    closeAccountPane(sessionId)
  }

  // Held outside the try so the catch can destroy a view that was created
  // before a later step threw — an orphaned WebContentsView on the LONG-LIVED
  // account partition is not a leak this function may produce.
  let createdView: WebContentsView | null = null
  let unsubscribe: (() => void) | null = null
  try {
    const ses = electronSession.fromPartition(partition)
    // The same plain-Chrome UA the in-app sign-in sets: the service's
    // bot-detection flags an "Electron" token.
    try { ses.setUserAgent(toChromeUserAgent(ses.getUserAgent())) } catch { /* non-fatal */ }
    // Harden the account partition. This partition is SHARED with the artifacts
    // and in-app-sign-in windows, so match THEIR posture rather than the
    // throwaway browsing partition's: deny active permission REQUESTS
    // (camera/mic/geo/etc.), but do NOT install a blanket permission-CHECK
    // handler — that silently kills `navigator.clipboard` (every Copy button on
    // the page and in the sibling windows) and some SSO storage-access flows.
    // Device permissions (WebUSB/serial/HID) default-deny with no handler.
    // Block downloads (the one hardening step the account partition otherwise
    // lacked): a session-bearing view must not hand the OS an unmediated
    // Save-As. Shared with the sign-in window, so the shared session gets
    // exactly one listener; it logs the host only (a signed download URL
    // carries its credential in the query).
    try {
      ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    } catch { /* harden best-effort; the webPreferences below still hold */ }
    blockPartitionDownloads(ses, 'account-pane')

    const view = new WebContentsView({
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        safeDialogs: true,
        safeDialogsMessage: 'Stop this page from opening more dialogs',
      },
    })

    createdView = view
    const entry: PaneEntry = {
      view,
      svc,
      ownerId,
      attachedTo: parent,
      authed: null,
      unsubscribeCookies: () => { /* replaced below */ },
      recording: false,
      recordDirty: false,
      backfilled: false,
      emailRetries: 0,
      authSeq: 0,
      refreshTimer: null,
      closed: false,
    }

    // MAIN-FRAME ONLY. The session-security invariant is about the top-level,
    // session-bearing document: it must not roam off its service. A cross-origin
    // SUB-FRAME is a different matter — it is isolated by same-origin policy (it
    // cannot read the service's cookies or DOM), and the service legitimately
    // embeds third-party frames (Cloudflare Turnstile, Stripe). Guarding those
    // would either break the embeds (block) or, worse, hand every embedded
    // frame's URL to the OS browser (external) - an un-gestured tab-bomb any page
    // could fire by creating an iframe. So sub-frames are left to same-origin
    // policy, and the guard acts only when the event is confirmed NOT a
    // sub-frame (a sub-frame's own navigations, through will-frame-navigate
    // below, are held to https or an embedded local document).
    const guard = (label: string) => (event: { preventDefault: () => void; isMainFrame?: boolean }, target: string): void => {
      if (event.isMainFrame === false) {
        // Sub-frame: left to same-origin policy (never blocked for being
        // third-party, never handed to the OS browser), but only https or an
        // embedded local document (about:blank, about:srcdoc, blob:, data:)
        // loads: http:, file: and custom schemes are refused, at zero risk of
        // the iframe tab-bomb.
        if (!subFrameNavAllowed(String(target))) { event.preventDefault(); logError(`[account-pane] blocked a sub-frame (${diagHost(String(target))})`) }
        return
      }
      const decision = svc.navDecision(target, entry.authed)
      if (decision === 'allow') return
      event.preventDefault()
      if (decision === 'external') {
        const href = safeExternalHttpsHref(target)
        if (href) void shell.openExternal(href)
        else logError('[account-pane] refused to hand a non-https URL to the OS')
      } else {
        // The host only: a blocked URL can carry an OAuth code or state in
        // its query or fragment.
        logError(`[account-pane] blocked ${label} to ${diagHost(String(target))}`)
      }
    }
    view.webContents.on('will-navigate', guard('will-navigate'))
    view.webContents.on('will-redirect', guard('will-redirect'))
    // will-navigate is the main frame's only: a sub-frame's own navigation
    // comes through will-frame-navigate, held to the same sub-frame rule
    // (https or an embedded local document - about:blank, about:srcdoc, blob:,
    // data: - never handed to the OS browser).
    view.webContents.on('will-frame-navigate', (event: { preventDefault: () => void; isMainFrame?: boolean; url?: string }) => {
      if (event?.isMainFrame !== false) return
      guard('will-frame-navigate')(event, String(event?.url ?? ''))
    })
    view.webContents.on('will-prevent-unload', (event) => { event.preventDefault() })
    view.webContents.setWindowOpenHandler(({ url }) => {
      // A popup is only ever followed into THIS view when it is the service's
      // own URL; a signed-in off-site popup goes to the real browser; everything
      // else is dropped. Never a new window, and - unlike a plain nav - loadURL
      // here bypasses the will-navigate guard, so the service check is explicit
      // and does NOT trust the pre-auth allowance (which a stale authed could
      // widen).
      if (svc.isServiceUrl(url)) {
        let href: string | null = null
        try { href = new URL(url).href } catch { href = null }
        if (href) loadQuietly(view.webContents, href, 'a service popup')
      } else if (svc.navDecision(url, entry.authed) === 'external') {
        const href = safeExternalHttpsHref(url)
        if (href) void shell.openExternal(href)
      }
      return { action: 'deny' }
    })
    // Esc closes the pane exactly like the ordinary view.
    view.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        try {
          if (!parent.isDestroyed()) parent.webContents.send(IPC.WEBVIEW_ESCAPE_PRESSED, sessionId)
        } catch { /* parent gone */ }
      }
    })

    const wc = view.webContents
    wc.on('did-start-loading', () => emitNav(entry, sessionId, true))
    wc.on('did-stop-loading', () => emitNav(entry, sessionId, false))
    wc.on('did-navigate', () => { emitNav(entry, sessionId, false); scheduleRefreshAuthed(sessionId) })
    // In-page nav too (both services are SPAs): a client-side route change is
    // where a sign-in / sign-out becomes visible without a full navigation, so
    // the authed state must be re-read here as well or it can stick stale.
    // Debounced so a page firing rapid in-page navs cannot spin the cookie +
    // file reads.
    wc.on('did-navigate-in-page', () => { emitNav(entry, sessionId, false); scheduleRefreshAuthed(sessionId) })
    wc.on('page-title-updated', () => emitNav(entry, sessionId, false))
    // The view's own process died (crash/OOM): evict the entry so a reopen
    // rebuilds rather than returning ok over a dead view, and tell the renderer
    // to leave account mode.
    wc.on('render-process-gone', () => { closeAccountPane(sessionId) })
    // The host window closing (macOS keeps the app alive) would otherwise leak
    // this entry + its listener on the long-lived account session.
    parent.once('closed', () => { closeAccountPane(sessionId) })

    // Watch the partition for the session cookie appearing or going: this is
    // both the sign-in detector and the strip's live authed dot. The listener
    // sits on the LONG-LIVED account session — the catch below unhooks it if
    // any later step (setBounds, addChildView) throws.
    const onCookieChanged = (_e: unknown, cookie: { name: string; domain?: string }): void => {
      // Immediate, not debounced: a real cookie write (sign-in/out) is the
      // signal that matters, and it is not page-spammable at high rate — the
      // A6 debounce is for page-driven did-navigate-in-page bursts only.
      if (!svc.isSessionCookieName(cookie.name)) return
      void refreshAuthed(sessionId)
    }
    ses.cookies.on('changed', onCookieChanged)
    entry.unsubscribeCookies = () => {
      try { ses.cookies.removeListener('changed', onCookieChanged) } catch { /* session gone */ }
    }
    unsubscribe = entry.unsubscribeCookies

    view.setBounds(bounds)
    // Through the arbiter: attaching the account view evicts any ordinary
    // browser view this window holds (and vice versa), so the two can never
    // stack on one rectangle.
    attachPaneView(parent, view)
    // A failure leaves the view open on its error page.
    loadQuietly(wc, svc.startUrl, 'the account view')
    panes.set(sessionId, entry)
    void refreshAuthed(sessionId)
    logInfo(`[account-pane] opened for session ${sessionId} as ${ownerId}`)
    return { ok: true }
  } catch (err) {
    // Nothing half-made survives a failed open: the cookie listener and the
    // view would otherwise be unreachable for the entire app lifetime.
    try { unsubscribe?.() } catch { /* session gone */ }
    try { createdView?.webContents.close() } catch { /* never attached */ }
    logError(`[account-pane] open failed: ${(err as Error)?.message ?? err}`)
    return { ok: false, error: (err as Error)?.message ?? 'could not open the account view' }
  }
}

/** Close a session's account view. A `reason` (main closed it for the user's
 *  sake, not on their request) goes to the renderer, which shows it. */
export function closeAccountPane(sessionId: string, reason?: string): boolean {
  const entry = panes.get(sessionId)
  if (!entry) return false
  // Before anything else: an in-flight recordSession must see the close and
  // refuse to write (sign-out empties the partition right after this).
  entry.closed = true
  if (entry.refreshTimer) { clearTimeout(entry.refreshTimer); entry.refreshTimer = null }
  entry.unsubscribeCookies()
  const parent = entry.attachedTo
  try {
    if (!parent.isDestroyed()) detachPaneView(parent, entry.view)
    entry.view.webContents.close()
  } catch (err) {
    logError(`[account-pane] close failed: ${(err as Error)?.message ?? err}`)
  }
  panes.delete(sessionId)
  // Tell the renderer to leave account mode. Harmless when the renderer
  // initiated the close (its store guard makes the second leave a no-op); the
  // point is the main-initiated closes — sign-out, account delete — where the
  // renderer would otherwise keep the strip up over nothing.
  notifyPaneClosed(parent, sessionId, reason)
  return true
}

export function setAccountPaneBounds(sessionId: string, bounds: AccountPaneBounds): void {
  const entry = panes.get(sessionId)
  if (!entry) return
  try { entry.view.setBounds(bounds) } catch { /* view gone */ }
}

/** Same attach/detach mechanics as the ordinary view — native views ignore CSS. */
export function setAccountPaneVisible(sessionId: string, visible: boolean): void {
  const entry = panes.get(sessionId)
  if (!entry || entry.attachedTo.isDestroyed()) return
  try {
    const children = entry.attachedTo.contentView.children
    const isAttached = children.includes(entry.view)
    if (visible && !isAttached) {
      attachPaneView(entry.attachedTo, entry.view)
    } else if (!visible && isAttached) {
      detachPaneView(entry.attachedTo, entry.view)
      try { entry.view.setBounds({ x: 0, y: 0, width: 1, height: 1 }) } catch { /* noop */ }
    }
  } catch (err) {
    logError(`[account-pane] setVisible failed: ${(err as Error)?.message ?? err}`)
  }
}

export function reloadAccountPane(sessionId: string): void {
  const entry = panes.get(sessionId)
  if (!entry) return
  try { entry.view.webContents.reloadIgnoringCache() } catch { /* view gone */ }
}

/** The pane state for one session, for a renderer that just (re)mounted. */
export function getAccountPaneState(sessionId: string): AccountPaneState | null {
  const entry = panes.get(sessionId)
  if (!entry) return null
  return entry.svc.stateOf(sessionId, entry.ownerId, entry.authed, entry.svc.stored(entry.ownerId)?.accountEmail ?? null)
}

/** Close every claude.ai account pane for one PROFILE - sign-out revokes the session. */
export function closeAccountPanesForProfile(profileId: string): void {
  for (const [sessionId, entry] of [...panes.entries()]) {
    if (entry.svc === CLAUDE_PANE && entry.ownerId === profileId) closeAccountPane(sessionId)
  }
}

/** Close every chatgpt.com account pane for one Codex ACCOUNT - its web
 *  session was cleared (sign-out, archive, an incomplete sign-in). */
export function closeCodexAccountPanes(accountId: string): void {
  for (const [sessionId, entry] of [...panes.entries()]) {
    if (entry.svc === CODEX_PANE && entry.ownerId === accountId) closeAccountPane(sessionId)
  }
}

/** Close every chatgpt.com account pane `shouldClose` names, by its session and
 *  account: the session no longer runs under that account (its launch ended,
 *  or switched to another account). A predicate that throws closes. Returns
 *  how many closed. */
export function closeCodexAccountPanesWhere(shouldClose: (sessionId: string, accountId: string) => boolean, reason?: string): number {
  let n = 0
  for (const [sessionId, entry] of [...panes.entries()]) {
    if (entry.svc !== CODEX_PANE) continue
    let close = true
    try { close = shouldClose(sessionId, entry.ownerId) !== false } catch { close = true }
    if (close && closeAccountPane(sessionId, reason)) n++
  }
  return n
}

/** Tear down all account panes — app quit. */
export function closeAllAccountPanes(): void {
  for (const sessionId of [...panes.keys()]) closeAccountPane(sessionId)
}
