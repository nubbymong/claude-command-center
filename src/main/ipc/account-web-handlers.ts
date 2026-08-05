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

import { BrowserWindow, ipcMain, app } from 'electron'
import { z } from 'zod'
import { IPC } from '../../shared/ipc-channels'
import { PROFILE_ID_RE } from '../../shared/account-web-session'
import { resolveAuthCdpPort } from '../../shared/cdp-ports'
import { logError } from '../debug-logger'
import { getDataDirectory } from '../data-paths'
import { cancelSignIn, clearWebSession, getSignInState, runSignIn } from '../account-web/sign-in'
import { removeWebSession, saveWebSession, viewFor } from '../account-web/session-store'
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
  ipcMain.handle(IPC.ACCOUNT_WEB_STATUS, async (_e, profileId: unknown) => {
    try {
      const id = profileIdSchema.parse(profileId)
      return { ok: true, web: viewFor(id), cli: readClaudeCliAuth(id), authCommand: claudeAuthCommand() }
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
        port: resolveAuthCdpPort(app.isPackaged),
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

  ipcMain.handle(IPC.ACCOUNT_WEB_CANCEL, async () => {
    try {
      cancelSignIn()
      return { ok: true }
    } catch (err) {
      return fail('cancel', err)
    }
  })

  ipcMain.handle(IPC.ACCOUNT_WEB_SIGN_OUT, async (_e, profileId: unknown) => {
    try {
      const id = profileIdSchema.parse(profileId)
      // Order matters: drop the cookies first, then the record. A crash between
      // them should leave no usable session with a record claiming otherwise.
      await clearWebSession(id)
      removeWebSession(id)
      closeArtifacts(id)
      return { ok: true }
    } catch (err) {
      return fail('signOut', err)
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
