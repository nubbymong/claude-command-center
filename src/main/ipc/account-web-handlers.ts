/**
 * account-web-handlers.ts — IPC seam for the per-account claude.ai web session (#216).
 *
 * Result envelopes rather than thrown rejections, for the same reason as the
 * desktop-import seam: the renderer shows these errors verbatim, and a rejected
 * `invoke` arrives as an opaque "Error invoking remote method".
 *
 * Every profileId is zod-validated HERE against the same shape the partition
 * builder enforces, so a malformed one is refused at the boundary rather than
 * deep inside a path or partition name.
 *
 * No default export (project convention).
 */

import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '../../shared/ipc-channels'
import { PROFILE_ID_RE } from '../../shared/account-web-session'
import { logError } from '../debug-logger'
import { getDataDirectory } from '../data-paths'
import { cancelSignIn, clearWebSession, detectAuthBrowsers, getSignInState, runSignIn } from '../account-web/sign-in'
import {
  getAuthBrowser,
  getAuthMethod,
  getWebSignInMode,
  removeWebSession,
  saveWebSession,
  setAuthBrowser,
  setAuthMethod,
  setWebSignInMode,
  viewFor,
} from '../account-web/session-store'
import { readClaudeCliAuth, claudeAuthCommand } from '../account-web/claude-cli-auth'
import { closeArtifacts, openArtifacts } from '../account-web/artifacts'
import { listProfiles } from '../account-profiles'
import {
  closeAccountPane,
  closeAccountPanesForProfile,
  getAccountPaneState,
  openAccountPane,
  reloadAccountPane,
  setAccountPaneBounds,
  setAccountPaneVisible,
} from '../account-web/account-pane'
import { closeWebview } from '../webview-manager'

type Err = { ok: false; error: string }

function fail(scope: string, err: unknown): Err {
  const error = (err as Error)?.message ?? String(err)
  logError(`[account-web] ${scope}: ${error}`)
  return { ok: false, error }
}

const profileIdSchema = z.string().regex(PROFILE_ID_RE)

/** True when the id names a real account. Shape-validation is not enough for
 *  the handlers that MATERIALISE a partition or persist a settings row (#439
 *  adversarial): a shape-valid but unknown id would mint an unbounded, never-
 *  GC'd `persist:claude-web-*` partition (or an unbounded settings row) that no
 *  UI can see or clear. */
function isKnownProfile(profileId: string): boolean {
  try {
    return listProfiles().some((p) => p.id === profileId)
  } catch {
    return false
  }
}

export function registerAccountWebHandlers(): void {
  /** Both halves of an account's auth in one payload — the UI shows them together. */
  // Web-session status on its own.
  //
  // ACCOUNT_WEB_STATUS awaits readClaudeCliAuth() -- a `claude auth status`
  // subprocess that can take seconds -- before it returns anything, including
  // the web view, which is a synchronous local JSON read. Anything that only
  // needs "does this account have a claude.ai session" was therefore paying for
  // the CLI probe: the sidebar context menu renders "Open artifacts" disabled
  // until the answer arrives, so on an account whose status was not already
  // cached the item was dead at the moment the user clicked it, with no window
  // and no log line. Split so the cheap question gets a cheap answer.
  ipcMain.handle(IPC.ACCOUNT_WEB_WEB_STATUS, async (_e, profileId: unknown) => {
    try {
      const id = profileIdSchema.parse(profileId)
      return { ok: true, web: viewFor(id) }
    } catch (err) {
      return fail('webStatus', err)
    }
  })

  ipcMain.handle(IPC.ACCOUNT_WEB_STATUS, async (_e, profileId: unknown) => {
    try {
      const id = profileIdSchema.parse(profileId)
      const cli = await readClaudeCliAuth(id)
      const authMethod = getAuthMethod(id)
      return {
        ok: true,
        web: viewFor(id),
        cli,
        authMethod,
        authBrowser: getAuthBrowser(id),
        webSignInMode: getWebSignInMode(id),
        // Which drivable browsers are actually installed (#439): the Settings
        // picker renders only when there is a genuine choice.
        detectedBrowsers: detectAuthBrowsers(),
        // Built from the account's OWN setting and its reported address, so the
        // command shown is the one that will actually work for this account.
        authCommand: claudeAuthCommand(authMethod, cli.email),
      }
    } catch (err) {
      return fail('status', err)
    }
  })

  ipcMain.handle(IPC.ACCOUNT_WEB_SIGN_IN, async (_e, profileId: unknown) => {
    try {
      const id = profileIdSchema.parse(profileId)
      const state = await runSignIn({
        profileId: id,
        dataDir: getDataDirectory(),
        // The ACCOUNT's method + browser, read here rather than inside the
        // sign-in: the store is the one authority on what this account chose.
        // `method` routes the flow — 'sso' uses the system browser, everything
        // else signs in in-app (no debug port; see sign-in.ts).
        method: getAuthMethod(id),
        browser: getAuthBrowser(id),
      })
      if (state.phase === 'done' && state.session) saveWebSession(state.session)
      return { ok: true, state }
    } catch (err) {
      return fail('signIn', err)
    }
  })

  /** Polled by the UI while a sign-in is in flight — it is a human-paced flow. */
  ipcMain.handle(IPC.ACCOUNT_WEB_SIGN_IN_STATE, async () => {
    try {
      return { ok: true, state: getSignInState() }
    } catch (err) {
      return fail('signInState', err)
    }
  })

  ipcMain.handle(IPC.ACCOUNT_WEB_CANCEL, async (_e, profileId: unknown) => {
    try {
      // SCOPED, AND THE ID IS REQUIRED HERE. The cancel flag is module-global,
      // so an unscoped cancel from one account's row aborted whichever sign-in
      // happened to be running. Leaving `undefined` acceptable at the boundary
      // would have left that exact cross-account cancel reachable from the
      // renderer — the only place it was ever reachable from. Main-process
      // callers that genuinely want "cancel whatever is running" (shutdown) call
      // cancelSignIn() directly and do not come through here.
      cancelSignIn(profileIdSchema.parse(profileId))
      return { ok: true }
    } catch (err) {
      return fail('cancel', err)
    }
  })

  ipcMain.handle(IPC.ACCOUNT_WEB_SIGN_OUT, async (_e, profileId: unknown) => {
    try {
      const id = profileIdSchema.parse(profileId)
      // Close the window FIRST: it is holding the session being revoked, and if
      // clearWebSession rejects, an open window on that account is the worst
      // outcome. Then drop the cookies, then the record — a crash between the
      // last two leaves no usable session with a record claiming otherwise.
      // The pane's account surfaces hold the same session — same rule (#439).
      closeArtifacts(id)
      closeAccountPanesForProfile(id)
      await clearWebSession(id)
      removeWebSession(id)
      return { ok: true }
    } catch (err) {
      return fail('signOut', err)
    }
  })

  ipcMain.handle(IPC.ACCOUNT_WEB_SET_AUTH_METHOD, async (_e, args: unknown) => {
    try {
      // The method is validated against the CLI's actual choices, not accepted
      // as a string: it becomes a `--flag` on a command shown to a human.
      const { profileId, method } = z
        .object({ profileId: profileIdSchema, method: z.enum(['claudeai', 'sso', 'console']) })
        .parse(args)
      setAuthMethod(profileId, method)
      return { ok: true }
    } catch (err) {
      return fail('setAuthMethod', err)
    }
  })

  ipcMain.handle(IPC.ACCOUNT_WEB_SET_AUTH_BROWSER, async (_e, args: unknown) => {
    try {
      // Enumerated, not accepted as a string: this value picks which executable
      // the sign-in spawns, so the boundary refuses anything else outright rather
      // than letting it reach the launcher.
      const { profileId, browser } = z
        .object({ profileId: profileIdSchema, browser: z.enum(['chrome', 'edge']) })
        .parse(args)
      setAuthBrowser(profileId, browser)
      return { ok: true }
    } catch (err) {
      return fail('setAuthBrowser', err)
    }
  })

  ipcMain.handle(IPC.ACCOUNT_WEB_OPEN_ARTIFACTS, async (e, profileId: unknown) => {
    try {
      const id = profileIdSchema.parse(profileId)
      const res = openArtifacts(id, BrowserWindow.fromWebContents(e.sender) ?? undefined)
      return res.ok ? { ok: true } : { ok: false, error: res.error ?? 'could not open artifacts' }
    } catch (err) {
      return fail('openArtifacts', err)
    }
  })

  ipcMain.handle(IPC.ACCOUNT_WEB_SET_SIGN_IN_MODE, async (_e, args: unknown) => {
    try {
      // Enumerated at the boundary like the sibling settings: this value routes
      // a credential flow, so it does not get to be arbitrary.
      const { profileId, mode } = z
        .object({ profileId: profileIdSchema, mode: z.enum(['auto', 'internal-pane']) })
        .parse(args)
      if (!isKnownProfile(profileId)) return { ok: false, error: 'unknown account' }
      setWebSignInMode(profileId, mode)
      return { ok: true }
    } catch (err) {
      return fail('setSignInMode', err)
    }
  })

  // ---- the pane's account surface (#439/#475) --------------------------------
  // Session ids become nothing on-disk here (the PARTITION is the account's,
  // named from the validated profile id), but the same strict charset keeps the
  // registry keys and log lines clean, and profileId is re-validated inside
  // webPartitionForProfile as well — two gates for the string that names the
  // cookie-jar boundary.
  const sessionIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
  const boundsSchema = z.object({
    x: z.number().int().min(0).max(20000),
    y: z.number().int().min(0).max(20000),
    width: z.number().int().min(1).max(20000),
    height: z.number().int().min(1).max(20000),
  })

  ipcMain.handle(IPC.ACCOUNT_WEB_PANE_OPEN, async (e, args: unknown) => {
    try {
      const { sessionId, profileId, bounds } = z
        .object({ sessionId: sessionIdSchema, profileId: profileIdSchema, bounds: boundsSchema })
        .parse(args)
      // A real account only: opening the surface for an unknown id would
      // materialise a partition with no owner and no cleanup path (#439).
      if (!isKnownProfile(profileId)) return { ok: false, error: 'unknown account' }
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win) return { ok: false, error: 'no window' }
      // MUTUAL EXCLUSION: the ordinary pane view and the account view share one
      // rectangle and must never both be attached (#439). The ordinary view is
      // an arbitrary-URL surface; it goes first.
      closeWebview(sessionId)
      return openAccountPane(win, sessionId, profileId, bounds)
    } catch (err) {
      return fail('paneOpen', err)
    }
  })

  ipcMain.handle(IPC.ACCOUNT_WEB_PANE_CLOSE, async (_e, sessionId: unknown) => {
    try {
      return { ok: true, closed: closeAccountPane(sessionIdSchema.parse(sessionId)) }
    } catch (err) {
      return fail('paneClose', err)
    }
  })

  ipcMain.handle(IPC.ACCOUNT_WEB_PANE_BOUNDS, async (_e, args: unknown) => {
    try {
      const { sessionId, bounds } = z.object({ sessionId: sessionIdSchema, bounds: boundsSchema }).parse(args)
      setAccountPaneBounds(sessionId, bounds)
      return { ok: true }
    } catch (err) {
      return fail('paneBounds', err)
    }
  })

  ipcMain.handle(IPC.ACCOUNT_WEB_PANE_VISIBLE, async (_e, args: unknown) => {
    try {
      const { sessionId, visible } = z.object({ sessionId: sessionIdSchema, visible: z.boolean() }).parse(args)
      setAccountPaneVisible(sessionId, visible)
      return { ok: true }
    } catch (err) {
      return fail('paneVisible', err)
    }
  })

  ipcMain.handle(IPC.ACCOUNT_WEB_PANE_RELOAD, async (_e, sessionId: unknown) => {
    try {
      reloadAccountPane(sessionIdSchema.parse(sessionId))
      return { ok: true }
    } catch (err) {
      return fail('paneReload', err)
    }
  })

  ipcMain.handle(IPC.ACCOUNT_WEB_PANE_GET_STATE, async (_e, sessionId: unknown) => {
    try {
      return { ok: true, state: getAccountPaneState(sessionIdSchema.parse(sessionId)) }
    } catch (err) {
      return fail('paneGetState', err)
    }
  })
}
