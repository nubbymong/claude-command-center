/**
 * account-pane.ts — the browser pane's ACCOUNT surface (#439/#475): a
 * claude.ai-only WebContentsView bound to one account's cookie partition,
 * hosted inside the app's browser pane rectangle.
 *
 * WHY A SEPARATE MODULE, not a mode of webview-manager: the ordinary pane view
 * loads whatever the user types, on a per-session throwaway partition that is
 * wiped when the tile closes. This view is the OPPOSITE trust domain — it rides
 * `persist:claude-web-<profileId>`, the partition holding the account's live
 * claude.ai session (the same one the artifacts window and the in-app sign-in
 * window use). The two views must never share code paths that could hand the
 * account partition an arbitrary URL: the pane's address bar, favourites, home
 * and page-commands all write to webview-manager and cannot reach this module.
 * Mutual exclusion (one of the two views per session) is enforced at the IPC
 * handler layer, which owns both modules.
 *
 * NAVIGATION POLICY (accountPaneNavDecision, pure and unit-tested):
 *   - claude.ai / www.claude.ai over https: allowed, always.
 *   - other https, top level, while the partition has NO session cookie yet:
 *     allowed — an SSO sign-in hops to an identity provider and back, exactly
 *     as the in-app sign-in window permits.
 *   - other https once SIGNED IN: blocked in-view and handed to the user's
 *     real browser — a link out of claude.ai must not carry a session-bearing
 *     view onto an arbitrary site (same rule as the artifacts window).
 *   - anything non-https: blocked outright.
 *
 * SIGN-IN RECORDING: when the partition transitions to holding a session
 * cookie while this view is open, the account's web-session record is saved
 * (origin 'in-pane') via the same cookie-shape helper the window flows use —
 * the cookie itself never leaves the partition; only metadata is written.
 *
 * No default export (project convention).
 */

import { BrowserWindow, WebContentsView, session as electronSession } from 'electron'
import { logError, logInfo } from '../debug-logger'
import { IPC } from '../../shared/ipc-channels'
import { webPartitionForProfile, CLAUDE_SESSION_COOKIE, type AccountWebSession } from '../../shared/account-web-session'
import { safeExternalHttpsHref } from '../../shared/safe-url'
import { shell } from 'electron'
import type { WebviewNavState } from '../../shared/browser-url'
import { webSessionFromElectronCookies } from './cookie-harvest'
import { toChromeUserAgent } from './in-app-sign-in'
import { getWebSession, saveWebSession } from './session-store'

/** Where the account surface starts: the account's artifacts. claude.ai
 *  redirects an unauthenticated visit to its login page by itself. */
export const ACCOUNT_PANE_START_URL = 'https://claude.ai/artifacts'

const CLAUDE_HOSTS = new Set(['claude.ai', 'www.claude.ai'])

export type AccountPaneNavDecision = 'allow' | 'block' | 'external'

/**
 * PURE: what to do with a top-level navigation in the account view.
 * `authed` is whether the partition currently holds a session cookie.
 */
export function accountPaneNavDecision(url: string, authed: boolean): AccountPaneNavDecision {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'block'
  }
  if (u.protocol !== 'https:') return 'block'
  if (CLAUDE_HOSTS.has(u.hostname.toLowerCase())) return 'allow'
  // Pre-auth: an IdP hop must complete in-view or SSO sign-in cannot work.
  // Post-auth: a session-bearing view does not roam; the link goes to the
  // user's real browser instead.
  return authed ? 'external' : 'allow'
}

export interface AccountPaneBounds {
  x: number
  y: number
  width: number
  height: number
}

/** What the renderer needs to draw the account strip. */
export interface AccountPaneState {
  sessionId: string
  profileId: string
  /** null while the first cookie read is in flight. */
  authed: boolean | null
  /** The recorded account email, when one is known. */
  email: string | null
}

interface PaneEntry {
  view: WebContentsView
  profileId: string
  attachedTo: BrowserWindow
  /** Latest known cookie state; null until the first read lands. */
  authed: boolean | null
  /** Stop the partition cookie listener. */
  unsubscribeCookies: () => void
  /** Guards the once-per-transition recording. */
  recording: boolean
}

const panes = new Map<string, PaneEntry>()

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

function sendState(entry: PaneEntry, sessionId: string): void {
  try {
    if (entry.attachedTo.isDestroyed()) return
    const state: AccountPaneState = {
      sessionId,
      profileId: entry.profileId,
      authed: entry.authed,
      email: getWebSession(entry.profileId)?.accountEmail ?? null,
    }
    entry.attachedTo.webContents.send(IPC.ACCOUNT_WEB_PANE_STATE, state)
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

/** Read the signed-in email from the live view, origin-gated — the same
 *  [LegacyUnforgeable]-location reasoning as the in-app sign-in window. */
async function readEmail(view: WebContentsView): Promise<string | null> {
  const expr =
    `(location.origin === 'https://claude.ai' || location.origin === 'https://www.claude.ai') ` +
    `? fetch('/api/bootstrap',{credentials:'include'}).then(r=>r.json())` +
    `.then(j=>(j&&j.account&&j.account.email_address)||null).catch(()=>null) ` +
    `: Promise.resolve(null)`
  try {
    const v = await Promise.race([
      Promise.resolve(view.webContents.executeJavaScript(expr, true)),
      new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
    ])
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

/**
 * The partition just transitioned to signed-in while the pane was open (or was
 * already signed in with no record on file): persist the metadata record so the
 * rest of the app — pills, artifacts gating — sees the session. Cookie stays in
 * the partition; this writes metadata only, exactly like the window flows.
 */
async function recordSession(entry: PaneEntry, expiresAt: number | null): Promise<void> {
  if (entry.recording) return
  entry.recording = true
  try {
    const email = await readEmail(entry.view)
    const session: AccountWebSession = {
      profileId: entry.profileId,
      accountEmail: email,
      acquiredAt: Date.now(),
      expiresAt,
      origin: 'in-pane',
    }
    saveWebSession(session)
    logInfo(`[account-pane] recorded claude.ai session for ${entry.profileId} (signed in via the pane)`)
  } catch (err) {
    logError(`[account-pane] could not record session: ${(err as Error)?.message ?? err}`)
  } finally {
    entry.recording = false
  }
}

/** Re-read the partition's cookie state; on unauthed->authed, record. */
async function refreshAuthed(sessionId: string): Promise<void> {
  const entry = panes.get(sessionId)
  if (!entry) return
  let cookies
  try {
    const ses = electronSession.fromPartition(webPartitionForProfile(entry.profileId))
    cookies = await ses.cookies.get({ url: 'https://claude.ai' })
  } catch {
    return
  }
  const { hasSessionCookie, expiresAt } = webSessionFromElectronCookies(cookies)
  const before = entry.authed
  entry.authed = hasSessionCookie
  if (hasSessionCookie && (before === false || (before === null && !getWebSession(entry.profileId)))) {
    // A fresh sign-in in this pane, or a partition that is signed in with no
    // record on file (a previous pane sign-in interrupted before recording).
    void recordSession(entry, expiresAt).then(() => sendState(entry, sessionId))
  }
  if (before !== entry.authed) sendState(entry, sessionId)
}

/**
 * Open (or refocus) the account surface for one session's pane.
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
  if (!SESSION_ID_RE.test(sessionId)) return { ok: false, error: 'session id is not path-safe' }
  let partition: string
  try {
    partition = webPartitionForProfile(profileId)
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? 'invalid account' }
  }

  const existing = panes.get(sessionId)
  if (existing) {
    if (existing.profileId === profileId) {
      try { existing.view.setBounds(bounds) } catch { /* view gone */ }
      return { ok: true }
    }
    // Same pane, different account (the session's account switched): replace.
    closeAccountPane(sessionId)
  }

  try {
    const ses = electronSession.fromPartition(partition)
    // The same plain-Chrome UA the in-app sign-in sets: claude.ai's
    // bot-detection flags an "Electron" token.
    try { ses.setUserAgent(toChromeUserAgent(ses.getUserAgent())) } catch { /* non-fatal */ }
    // Same lock-down as every account surface: nothing on a page's say-so.
    try {
      ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
      ses.setPermissionCheckHandler(() => false)
      ses.setDevicePermissionHandler(() => false)
    } catch { /* harden best-effort; the webPreferences below still hold */ }

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

    const entry: PaneEntry = {
      view,
      profileId,
      attachedTo: parent,
      authed: null,
      unsubscribeCookies: () => { /* replaced below */ },
      recording: false,
    }

    const guard = (label: string) => (event: { preventDefault: () => void }, target: string): void => {
      const decision = accountPaneNavDecision(target, entry.authed === true)
      if (decision === 'allow') return
      event.preventDefault()
      if (decision === 'external') {
        const href = safeExternalHttpsHref(target)
        if (href) void shell.openExternal(href)
        else logError('[account-pane] refused to hand a non-https URL to the OS')
      } else {
        logError(`[account-pane] blocked ${label}: ${String(target).slice(0, 200)}`)
      }
    }
    view.webContents.on('will-navigate', guard('will-navigate'))
    view.webContents.on('will-redirect', guard('will-redirect'))
    view.webContents.on('will-prevent-unload', (event) => { event.preventDefault() })
    view.webContents.setWindowOpenHandler(({ url }) => {
      // claude.ai popups load in THIS view; anything else follows the nav
      // policy (external when signed in, dropped otherwise). Never a new window.
      const decision = accountPaneNavDecision(url, entry.authed === true)
      if (decision === 'allow') {
        try { view.webContents.loadURL(new URL(url).href) } catch { /* view gone */ }
      } else if (decision === 'external') {
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
    wc.on('did-navigate', () => { emitNav(entry, sessionId, false); void refreshAuthed(sessionId) })
    wc.on('did-navigate-in-page', () => emitNav(entry, sessionId, false))
    wc.on('page-title-updated', () => emitNav(entry, sessionId, false))

    // Watch the partition for the session cookie appearing or going: this is
    // both the sign-in detector and the strip's live authed dot.
    const onCookieChanged = (_e: unknown, cookie: { name: string; domain?: string }): void => {
      if (cookie.name !== CLAUDE_SESSION_COOKIE) return
      void refreshAuthed(sessionId)
    }
    ses.cookies.on('changed', onCookieChanged)
    entry.unsubscribeCookies = () => {
      try { ses.cookies.removeListener('changed', onCookieChanged) } catch { /* session gone */ }
    }

    view.setBounds(bounds)
    parent.contentView.addChildView(view)
    void wc.loadURL(ACCOUNT_PANE_START_URL).catch((err) => {
      logError(`[account-pane] loadURL failed: ${(err as Error)?.message ?? err} — view stays open with the error page`)
    })
    panes.set(sessionId, entry)
    void refreshAuthed(sessionId)
    logInfo(`[account-pane] opened for session ${sessionId} as ${profileId}`)
    return { ok: true }
  } catch (err) {
    logError(`[account-pane] open failed: ${(err as Error)?.message ?? err}`)
    return { ok: false, error: (err as Error)?.message ?? 'could not open the account view' }
  }
}

export function closeAccountPane(sessionId: string): boolean {
  const entry = panes.get(sessionId)
  if (!entry) return false
  entry.unsubscribeCookies()
  try {
    if (!entry.attachedTo.isDestroyed()) entry.attachedTo.contentView.removeChildView(entry.view)
    entry.view.webContents.close()
  } catch (err) {
    logError(`[account-pane] close failed: ${(err as Error)?.message ?? err}`)
  }
  panes.delete(sessionId)
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
      entry.attachedTo.contentView.addChildView(entry.view)
    } else if (!visible && isAttached) {
      entry.attachedTo.contentView.removeChildView(entry.view)
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
  return {
    sessionId,
    profileId: entry.profileId,
    authed: entry.authed,
    email: getWebSession(entry.profileId)?.accountEmail ?? null,
  }
}

/** Close every account pane for one PROFILE — sign-out revokes the session. */
export function closeAccountPanesForProfile(profileId: string): void {
  for (const [sessionId, entry] of [...panes.entries()]) {
    if (entry.profileId === profileId) closeAccountPane(sessionId)
  }
}

/** Tear down all account panes — app quit. */
export function closeAllAccountPanes(): void {
  for (const sessionId of [...panes.keys()]) closeAccountPane(sessionId)
}
