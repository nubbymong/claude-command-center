/**
 * codex-web-handlers.ts: the IPC seam for a Codex account's chatgpt.com web
 * session (WP2 PR 4, P4.6, row 58). The twin of account-web-handlers.ts for
 * Claude's claude.ai session, with three gates on EVERY channel:
 *   1. The trusted sender (ipc/trusted-sender.ts): only the app's own window,
 *      its top frame, is answered.
 *   2. A strict id schema: the `account` id class only (`acct-<hex>`, the
 *      registry's own pattern). A Claude profile id, or anything else, is
 *      refused at the boundary.
 *   3. The registry check: the account is known, is a Codex account, is not
 *      archived, and is not being archived. A Codex partition (the sign-in
 *      window's or the pane's) is only ever made after this check: an unknown
 *      id would otherwise mint a partition no UI can see or clear.
 * The renderer never supplies a URL, a host or a partition name: the pane
 * opens the descriptor's start page, and the window its sign-in page.
 *
 * Result envelopes rather than thrown rejections, for the same reason as
 * account-web-handlers.ts: the renderer shows these errors verbatim.
 *
 * No default export (project convention).
 */

import { ipcMain, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { IPC } from '../../shared/ipc-channels'
import { isWebSessionAccountId } from '../../shared/account-web-session'
import { logError } from '../debug-logger'
import { appWindowSender } from './trusted-sender'
import { getAccountRegistry, getConsumerLeases } from '../provider-account-registry'
import {
  cancelCodexWebSignIn,
  clearCodexWebSession,
  discardCodexWebRun,
  getCodexWebSignInState,
  isCodexWebArchiving,
  isCodexWebClearing,
  runCodexWebSignIn,
} from '../account-web/codex-web-session'
import { codexWebViewFor, saveCodexWebSession } from '../account-web/codex-web-store'
import { openCodexAccountPane } from '../account-web/account-pane'
import { closeWebview } from '../webview-manager'

type Err = { ok: false; error: string }

function fail(scope: string, err: unknown): Err {
  const error = (err as Error)?.message ?? String(err)
  logError(`[codex-web] ${scope}: ${error}`)
  return { ok: false, error }
}

const accountIdSchema = z.string().refine((v) => isWebSessionAccountId(v))
const sessionIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
const boundsSchema = z.object({
  x: z.number().int().min(0).max(20000),
  y: z.number().int().min(0).max(20000),
  width: z.number().int().min(1).max(20000),
  height: z.number().int().min(1).max(20000),
}).strict()
const paneOpenSchema = z.object({ sessionId: sessionIdSchema, accountId: accountIdSchema, bounds: boundsSchema }).strict()

/**
 * Why this account may not have a chatgpt.com web session made or used now,
 * or null when it may: known to the registry, a Codex account, not archived,
 * not being archived, and its web session not being cleared. No registry (or
 * one that cannot be read) refuses.
 */
export function codexWebAccountRefusal(accountId: string): string | null {
  let accounts: ReadonlyArray<{ id: string; providerId: string; lifecycle: string }> | undefined
  try {
    accounts = getAccountRegistry()?.current()?.accounts
  } catch {
    accounts = undefined
  }
  if (!accounts) return 'The account list is not available.'
  const a = accounts.find((x) => x.id === accountId)
  if (!a) return 'unknown account'
  if (a.providerId !== 'codex') return 'not a Codex account'
  if (a.lifecycle === 'archived') return 'This account is archived.'
  if (isCodexWebArchiving(accountId)) return 'This account is being archived.'
  if (isCodexWebClearing(accountId)) return "This account's chatgpt.com sign-in is being cleared. Try again in a moment."
  return null
}

/** The schema, then the registry: the account id, or the refusal. */
function eligible(raw: unknown): { ok: true; id: string } | Err {
  const parsed = accountIdSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'not a Codex account id' }
  const refusal = codexWebAccountRefusal(parsed.data)
  return refusal ? { ok: false, error: refusal } : { ok: true, id: parsed.data }
}

const FOREIGN: Err = { ok: false, error: 'refused: not the app window' }

/** The default binding: the session holds a lease on the account (its launch
 *  took one under that session's id). */
function sessionHoldsAccount(sessionId: string, accountId: string): boolean {
  return getConsumerLeases().sessionsHolding(accountId).includes(sessionId)
}

export interface CodexWebHandlerOptions {
  /** Whether the app session runs under the account. The composition root
   *  hands in the strict form (a Codex session holding the account's launch
   *  lease); a throw refuses. */
  sessionRunsUnder?: (sessionId: string, accountId: string) => boolean
}

export function registerCodexWebHandlers(getWindow: () => BrowserWindow | null, opts: CodexWebHandlerOptions = {}): void {
  const trusted = appWindowSender(getWindow)
  const runsUnder = (sessionId: string, accountId: string): boolean => {
    try { return (opts.sessionRunsUnder ?? sessionHoldsAccount)(sessionId, accountId) === true } catch { return false }
  }

  ipcMain.handle(IPC.CODEX_WEB_STATUS, async (e, accountId: unknown) => {
    if (!trusted(e)) return FOREIGN
    try {
      const el = eligible(accountId)
      if (!el.ok) return el
      return { ok: true, web: codexWebViewFor(el.id) }
    } catch (err) {
      return fail('status', err)
    }
  })

  ipcMain.handle(IPC.CODEX_WEB_SIGN_IN, async (e, accountId: unknown) => {
    if (!trusted(e)) return FOREIGN
    try {
      const el = eligible(accountId)
      if (!el.ok) return el
      const state = await runCodexWebSignIn({ accountId: el.id })
      if (state.phase === 'done' && state.session) {
        // RE-CHECKED after the human-paced run: an archive (or removal) that
        // landed meanwhile must not get a record, and what the run made goes.
        if (codexWebAccountRefusal(el.id) !== null) {
          const error = 'The account changed during the sign-in, so the session was discarded.'
          discardCodexWebRun(el.id, error)
          try { await clearCodexWebSession(el.id) } catch (err) { logError(`[codex-web] could not clear a discarded sign-in for ${el.id}: ${(err as Error)?.message ?? err}`) }
          return { ok: true, state: { phase: 'failed', accountId: el.id, error } }
        }
        // A session with no record would read signed out with nothing to sign
        // out of: a record that cannot be written clears the session too.
        if (saveCodexWebSession(state.session) === false) {
          const error = 'The sign-in finished, but it could not be recorded, so it was cleared. Try again.'
          discardCodexWebRun(el.id, error)
          try { await clearCodexWebSession(el.id) } catch (err) { logError(`[codex-web] could not clear an unrecorded sign-in for ${el.id}: ${(err as Error)?.message ?? err}`) }
          return { ok: true, state: { phase: 'failed', accountId: el.id, error } }
        }
      }
      return { ok: true, state }
    } catch (err) {
      return fail('signIn', err)
    }
  })

  /** Polled by the UI while a sign-in is in flight; it is a human-paced flow. */
  ipcMain.handle(IPC.CODEX_WEB_SIGN_IN_STATE, async (e) => {
    if (!trusted(e)) return FOREIGN
    try {
      return { ok: true, state: getCodexWebSignInState() }
    } catch (err) {
      return fail('signInState', err)
    }
  })

  ipcMain.handle(IPC.CODEX_WEB_CANCEL, async (e, accountId: unknown) => {
    if (!trusted(e)) return FOREIGN
    try {
      // SCOPED, and the id is required: only that account's run is cancelled.
      const el = eligible(accountId)
      if (!el.ok) return el
      cancelCodexWebSignIn(el.id)
      return { ok: true }
    } catch (err) {
      return fail('cancel', err)
    }
  })

  ipcMain.handle(IPC.CODEX_WEB_SIGN_OUT, async (e, accountId: unknown) => {
    if (!trusted(e)) return FOREIGN
    try {
      const el = eligible(accountId)
      if (!el.ok) return el
      // As Claude's sign-out, all inside the clear: the panes holding the
      // session close FIRST, then the partition is wiped (a failure throws and
      // keeps the record, so the account can be signed out again), then the
      // record goes; a record that cannot be removed throws too, so it is
      // reported, never "signed out".
      await clearCodexWebSession(el.id)
      return { ok: true }
    } catch (err) {
      return fail('signOut', err)
    }
  })

  ipcMain.handle(IPC.CODEX_WEB_PANE_OPEN, async (e, args: unknown) => {
    if (!trusted(e)) return FOREIGN
    try {
      const parsed = paneOpenSchema.safeParse(args)
      if (!parsed.success) return { ok: false, error: 'invalid pane request' }
      const { sessionId, accountId, bounds } = parsed.data
      const el = eligible(accountId)
      if (!el.ok) return el
      // The view is the session's own account's: a session that does not run
      // under the account gets no view of it.
      if (!runsUnder(sessionId, el.id)) return { ok: false, error: 'This session does not run under that account.' }
      const win = getWindow()
      if (!win) return { ok: false, error: 'no window' }
      // MUTUAL EXCLUSION: the ordinary pane view and the account view share one
      // rectangle and must never both be attached (#439). The ordinary view is
      // an arbitrary-URL surface; it goes first.
      closeWebview(sessionId)
      return openCodexAccountPane(win, sessionId, el.id, bounds)
    } catch (err) {
      return fail('paneOpen', err)
    }
  })
}
