/**
 * codex-web-session.ts: a Codex account's chatgpt.com web session (WP2 PR 4,
 * P4.6, row 58). The run, the clear, and the archive hook.
 *
 * Parity: chatgpt.com is to a Codex account what claude.ai is to a Claude
 * account, so this follows sign-in.ts's in-app route and clearWebSession:
 *   - The sign-in runs in an app window on the account's own partition
 *     (`persist:codex-web-<acct id>`), never a launched browser and never a
 *     cookie copy (WP1 design principle 4). It completes only with the session
 *     cookie AND a valid email (in-app-sign-in.ts, fail closed).
 *   - A run that ends WITHOUT a session (cancel, the window closed, a timeout)
 *     wipes the partition and forgets the record and the account's panes,
 *     exactly as Claude's in-app route does (#439 adversarial A3).
 *   - One sign-in at a time ACROSS services (sign-in-flight.ts).
 *   - Cancel is scoped to the account, and closes only THIS module's window
 *     (its own SignInWindowHandle): a Claude cancel or sign-out never closes a
 *     Codex window, and a Codex cancel never closes Claude's.
 *   - Clear cancels first, wipes storage (a failure throws: nothing reports
 *     "signed out" over a live session), then the HTTP cache (best effort), then
 *     tells its subscribers (the record and the panes are forgotten).
 *   - Archive (prepareCodexWebArchive, registered on the accounts service's
 *     archive seam at start) bars the account from a new sign-in, clears its web
 *     session FIRST, and fails if the clear fails (the precedent is Claude's
 *     account delete). The Codex CLI's own sign-out does NOT clear the web
 *     session, as Claude's CLI sign-out never does.
 *
 * Narrow module graph on purpose (electron, the logger, the shared types, the
 * window module): the record and the panes subscribe through
 * onCodexWebSessionCleared at start (index.ts), as Claude's do through
 * partition-revocation.ts.
 *
 * No default export (project convention).
 */

import { session as electronSession } from 'electron'
import { logError, logInfo } from '../debug-logger'
import {
  CODEX_WEB_SERVICE,
  isWebSessionAccountId,
  webPartitionForCodexAccount,
  type CodexWebSession,
  type CodexWebSignInState,
} from '../../shared/account-web-session'
import { closeInAppSignInWindow, createSignInWindowHandle, runServiceSignIn } from './in-app-sign-in'
import { registerSignInFlight, signInInFlightElsewhere } from './sign-in-flight'

export type { CodexWebSignInPhase, CodexWebSignInState } from '../../shared/account-web-session'

const IO_CALL_TIMEOUT_MS = 10_000
const DEFAULT_TIMEOUT_MS = 5 * 60_000
const DEFAULT_POLL_MS = 1500

let current: CodexWebSignInState = { phase: 'idle', accountId: null }
let cancelled = false
/** This module's own sign-in window: never Claude's. */
const signInWindow = createSignInWindowHandle()
/** Accounts an archive is clearing: no sign-in starts on them meanwhile. */
const archiving = new Set<string>()
const clearedHandlers = new Set<(accountId: string) => void>()

function inFlight(): boolean {
  return current.phase === 'awaiting-user'
}
registerSignInFlight('codex', inFlight)

export function getCodexWebSignInState(): CodexWebSignInState {
  return current
}

/** True while an archive of this account is clearing its web session. */
export function isCodexWebArchiving(accountId: string): boolean {
  return archiving.has(accountId)
}

/** Subscribe to "this account's web session was wiped" (the record, the panes). */
export function onCodexWebSessionCleared(handler: (accountId: string) => void): void {
  clearedHandlers.add(handler)
}

function notifyCleared(accountId: string): void {
  for (const handler of [...clearedHandlers]) {
    try { handler(accountId) } catch { /* one subscriber must not stop the rest */ }
  }
}

async function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`[codex-web] ${what} timed out`)), IO_CALL_TIMEOUT_MS)
        if (typeof (timer as { unref?: () => void })?.unref === 'function') (timer as { unref: () => void }).unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Run one Codex account's chatgpt.com sign-in. Resolves with the final state;
 * never throws. The caller (the IPC layer) has already confirmed from the
 * registry that the account is a known, non-archived Codex account; this
 * re-validates the id's shape and the archive bar before making the partition.
 */
export async function runCodexWebSignIn(opts: { accountId: string; timeoutMs?: number; pollMs?: number }): Promise<CodexWebSignInState> {
  const accountId = opts?.accountId
  if (inFlight() || signInInFlightElsewhere('codex')) {
    return { phase: 'failed', accountId: typeof accountId === 'string' ? accountId : null, error: 'A sign-in is already in progress. Finish or cancel it first.' }
  }
  if (!isWebSessionAccountId(accountId)) {
    return { phase: 'failed', accountId: null, error: 'Not a Codex account.' }
  }
  if (archiving.has(accountId)) {
    return { phase: 'failed', accountId, error: 'This account is being archived.' }
  }
  let partition: string
  try {
    partition = webPartitionForCodexAccount(accountId)
  } catch (err) {
    return { phase: 'failed', accountId, error: (err as Error)?.message ?? String(err) }
  }

  cancelled = false
  current = { phase: 'awaiting-user', accountId }
  try {
    const res = await runServiceSignIn({
      service: CODEX_WEB_SERVICE,
      ownerId: accountId,
      partition,
      handle: signInWindow,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      pollMs: opts.pollMs ?? DEFAULT_POLL_MS,
      shouldCancel: () => cancelled,
    })
    if (res.ok && typeof res.email === 'string') {
      const session: CodexWebSession = {
        accountId,
        accountEmail: res.email,
        acquiredAt: Date.now(),
        expiresAt: res.expiresAt ?? null,
        origin: 'in-app',
      }
      current = { phase: 'done', accountId, session }
      return current
    }
    // NON-COMPLETION: the window writes cookies straight into this partition
    // as the user signs in, so a run that ends without a session can leave a
    // live one behind. Wipe it and forget the record and the panes.
    await wipeAfterIncompleteRun(accountId, partition)
    current = { phase: 'failed', accountId, error: res.error ?? (res.cancelled ? 'Sign-in cancelled.' : 'Sign-in failed.') }
    return current
  } catch (err) {
    // runServiceSignIn never throws; defence in depth so the single-flight
    // latch is always released.
    closeInAppSignInWindow(signInWindow)
    await wipeAfterIncompleteRun(accountId, partition)
    current = { phase: 'failed', accountId, error: (err as Error)?.message ?? String(err) }
    return current
  }
}

async function wipeAfterIncompleteRun(accountId: string, partition: string): Promise<void> {
  try {
    await withTimeout(Promise.resolve(electronSession.fromPartition(partition).clearStorageData()), 'clearStorageData')
  } catch (err) {
    logError(`[codex-web] could not clear an incomplete sign-in for ${accountId}: ${(err as Error)?.message ?? err}`)
  }
  notifyCleared(accountId)
}

/**
 * Cancel the in-flight Codex sign-in. SCOPED: with an account id, only that
 * account's run is cancelled. Closes this module's window only.
 */
export function cancelCodexWebSignIn(accountId?: string): void {
  if (accountId && current.accountId && current.accountId !== accountId) return
  if (!inFlight()) return
  cancelled = true
  closeInAppSignInWindow(signInWindow)
}

/**
 * Forget one Codex account's chatgpt.com web session: sign-out and archive.
 * Clears the WHOLE partition (cookies, storage, then the HTTP cache). The
 * storage wipe failing THROWS, and the record and panes are only forgotten
 * after it succeeded, so a failed wipe never reads as signed out.
 */
export async function clearCodexWebSession(accountId: string): Promise<void> {
  const partition = webPartitionForCodexAccount(accountId)
  // CANCEL FIRST: a sign-in for this account may be mid-poll and would
  // otherwise write a fresh session into the partition being cleared.
  cancelCodexWebSignIn(accountId)
  const store = electronSession.fromPartition(partition)
  await withTimeout(Promise.resolve(store.clearStorageData()), 'clearStorageData')
  try {
    await withTimeout(Promise.resolve(store.clearCache()), 'clearCache')
  } catch (err) {
    logError(`[codex-web] could not clear the HTTP cache for ${accountId}: ${(err as Error)?.message ?? err}`)
  }
  notifyCleared(accountId)
  logInfo(`[codex-web] cleared the chatgpt.com web session for ${accountId}`)
}

/**
 * The accounts service's archive hook (account-archive-hooks.ts, wired at
 * start). For a Codex account: bar new sign-ins, clear the web session, and
 * return the release that lifts the bar once the archive settles (an archived
 * account is refused by the registry check from then on; one whose archive
 * failed may sign in again). A clear that fails rejects, which refuses the
 * archive. Any other provider: nothing.
 */
export async function prepareCodexWebArchive(accountId: string, providerId: string): Promise<() => void> {
  if (providerId !== 'codex') return () => { /* not ours */ }
  archiving.add(accountId)
  try {
    await clearCodexWebSession(accountId)
  } catch (err) {
    archiving.delete(accountId)
    throw err
  }
  return () => { archiving.delete(accountId) }
}

/** Tests only: back to a fresh module state. */
export function _resetCodexWebForTest(): void {
  closeInAppSignInWindow(signInWindow)
  current = { phase: 'idle', accountId: null }
  cancelled = false
  archiving.clear()
  clearedHandlers.clear()
}
