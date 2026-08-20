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
import { cancelSignIn, clearWebSession, getSignInState, runSignIn } from '../account-web/sign-in'
import {
  getAuthBrowser,
  getAuthMethod,
  removeWebSession,
  saveWebSession,
  setAuthBrowser,
  setAuthMethod,
  viewFor,
} from '../account-web/session-store'
import { readClaudeCliAuth, claudeAuthCommand } from '../account-web/claude-cli-auth'
import { closeArtifacts, openArtifacts } from '../account-web/artifacts'

type Err = { ok: false; error: string }

function fail(scope: string, err: unknown): Err {
  const error = (err as Error)?.message ?? String(err)
  logError(`[account-web] ${scope}: ${error}`)
  return { ok: false, error }
}

const profileIdSchema = z.string().regex(PROFILE_ID_RE)

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
      closeArtifacts(id)
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
}
