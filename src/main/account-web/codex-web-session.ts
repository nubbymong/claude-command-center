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
 *     wipes the partition, exactly as Claude's in-app route does (#439
 *     adversarial A3): the account's panes close first, then the wipe, and the
 *     record is forgotten only once the wipe succeeded.
 *   - One sign-in at a time ACROSS services (sign-in-flight.ts).
 *   - Cancel is scoped to the account, and closes only THIS module's window
 *     (its own SignInWindowHandle): a Claude cancel or sign-out never closes a
 *     Codex window, and a Codex cancel never closes Claude's.
 *   - Clear (sign-out and archive) bars the account from a new sign-in or pane
 *     for its whole run, cancels a run in flight (its window closes), closes the
 *     account's panes, and only THEN wipes storage (a failure throws: nothing
 *     reports "signed out" over a live session) and the HTTP cache (best
 *     effort); the record is forgotten after the wipe, and a record that cannot
 *     be removed fails the clear. Nothing that holds the session is still open
 *     while the partition is wiped, so nothing can write it back (Claude's
 *     account delete closes its panes first for the same reason).
 *   - Archive (prepareCodexWebArchive, registered on the accounts service's
 *     archive seam at start) bars the account from a new sign-in until the
 *     archive settles, clears its web session before the archive changes
 *     anything, and fails if the clear fails (the precedent is Claude's account
 *     delete). The Codex CLI's own sign-out does NOT clear the web session, as
 *     Claude's CLI sign-out never does.
 *
 * Narrow module graph on purpose (electron, the logger, the shared types, the
 * window module): the panes and the record subscribe at start (index.ts)
 * through onCodexWebSessionClosing and onCodexWebSessionCleared, as Claude's
 * do through partition-revocation.ts.
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
import { bounded, closeInAppSignInWindow, createSignInWindowHandle, runServiceSignIn } from './in-app-sign-in'
import type { CodexWebRecordsForSweep } from './codex-web-store'
import { registerSignInFlight, signInInFlightElsewhere } from './sign-in-flight'

export type { CodexWebSignInPhase, CodexWebSignInState } from '../../shared/account-web-session'

const DEFAULT_TIMEOUT_MS = 5 * 60_000
const DEFAULT_POLL_MS = 1500

let current: CodexWebSignInState = { phase: 'idle', accountId: null }
let cancelled = false
/** This module's own sign-in window: never Claude's. */
const signInWindow = createSignInWindowHandle()
/** Accounts an archive is clearing: no sign-in starts on them until it settles. */
const archiving = new Set<string>()
/** Accounts whose web session is being wiped now (a sign-out, an archive, an
 *  unfinished sign-in), counted: overlapping wipes of one account keep the
 *  bar up until the last one ends. */
const clearing = new Map<string, number>()

/** Bar the account for one wipe; the returned release lifts this wipe's share. */
function barWhileClearing(accountId: string): () => void {
  clearing.set(accountId, (clearing.get(accountId) ?? 0) + 1)
  let done = false
  return () => {
    if (done) return
    done = true
    const n = (clearing.get(accountId) ?? 1) - 1
    if (n > 0) clearing.set(accountId, n)
    else clearing.delete(accountId)
  }
}
/** Told BEFORE a wipe: close everything that holds the session (the panes). */
const closingHandlers = new Set<(accountId: string) => void>()
/** Told AFTER a wipe that succeeded: forget the record. `false` = it could not. */
const clearedHandlers = new Set<(accountId: string) => boolean | void>()

function inFlight(): boolean {
  return current.phase === 'awaiting-user'
}
registerSignInFlight('codex', inFlight)

export function getCodexWebSignInState(): CodexWebSignInState {
  return current
}

/** True while an archive of this account is clearing or settling. */
export function isCodexWebArchiving(accountId: string): boolean {
  return archiving.has(accountId)
}

/** True while any wipe of this account's web session runs. */
export function isCodexWebClearing(accountId: string): boolean {
  return (clearing.get(accountId) ?? 0) > 0
}

/** Subscribe to "this account's web session is about to be wiped": close
 *  everything that holds it (the panes), so nothing writes it back mid-wipe. */
export function onCodexWebSessionClosing(handler: (accountId: string) => void): void {
  closingHandlers.add(handler)
}

/** Subscribe to "this account's web session was wiped": forget the record.
 *  A handler returning `false` says it could not, and the clear fails. */
export function onCodexWebSessionCleared(handler: (accountId: string) => boolean | void): void {
  clearedHandlers.add(handler)
}

function notifyClosing(accountId: string): void {
  for (const handler of [...closingHandlers]) {
    try { handler(accountId) } catch { /* one subscriber must not stop the rest */ }
  }
}

/** True when every subscriber forgot what it held. */
function notifyCleared(accountId: string): boolean {
  let ok = true
  for (const handler of [...clearedHandlers]) {
    try { if (handler(accountId) === false) ok = false } catch { ok = false }
  }
  return ok
}

/**
 * Run one Codex account's chatgpt.com sign-in. Resolves with the final state;
 * never throws. The caller (the IPC layer) has already confirmed from the
 * registry that the account is a known, non-archived Codex account; this
 * re-validates the id's shape and the archive and clear bars before making the
 * partition.
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
  if (isCodexWebClearing(accountId)) {
    return { phase: 'failed', accountId, error: 'This account\'s chatgpt.com sign-in is being cleared. Try again in a moment.' }
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
    // live one behind. Wipe it.
    await wipeAfterIncompleteRun(accountId, partition)
    current = { phase: 'failed', accountId, error: res.error ?? (res.cancelled ? 'Sign-in cancelled.' : 'Sign-in failed.') }
    return current
  } catch (err) {
    // runServiceSignIn is contracted never to throw; this keeps that contract
    // here too, so the single-flight latch is always released and the
    // partition is wiped whatever went wrong.
    closeInAppSignInWindow(signInWindow)
    await wipeAfterIncompleteRun(accountId, partition)
    current = { phase: 'failed', accountId, error: (err as Error)?.message ?? String(err) }
    return current
  }
}

/**
 * Wipe one Codex account's partition, the same on every path (an unfinished
 * sign-in, a sign-out, an archive, the start sweep): its stored data (cookies,
 * local and session storage, IndexedDB and the rest), then its HTTP cache,
 * then its code caches, each bounded. The stored data holds the session, so a
 * failure there throws and the caller keeps the record (fail closed); a cache
 * that cannot be cleared is logged, the session being gone already.
 */
async function wipeCodexPartition(partition: string, accountId: string): Promise<void> {
  const store = electronSession.fromPartition(partition)
  await bounded(Promise.resolve(store.clearStorageData()), 'clearStorageData')
  try {
    await bounded(Promise.resolve(store.clearCache()), 'clearCache')
  } catch (err) {
    logError(`[codex-web] could not clear the HTTP cache for ${accountId}: ${(err as Error)?.message ?? err}`)
  }
  try {
    await bounded(Promise.resolve(store.clearCodeCaches({})), 'clearCodeCaches')
  } catch (err) {
    logError(`[codex-web] could not clear the code cache for ${accountId}: ${(err as Error)?.message ?? err}`)
  }
}

/** The panes close first, then the wipe; the record is forgotten only after a
 *  wipe that succeeded (a failed one leaves it, so Sign out stays offered). */
async function wipeAfterIncompleteRun(accountId: string, partition: string): Promise<void> {
  // Barred like any clear: no pane opens on the partition while it is wiped.
  const unbar = barWhileClearing(accountId)
  try {
    notifyClosing(accountId)
    try {
      await wipeCodexPartition(partition, accountId)
    } catch (err) {
      logError(`[codex-web] could not clear an incomplete sign-in for ${accountId}: ${(err as Error)?.message ?? err}`)
      return
    }
    if (!notifyCleared(accountId)) logError(`[codex-web] could not forget the chatgpt.com record of ${accountId} after an incomplete sign-in`)
  } finally {
    unbar()
  }
}

/**
 * At start: wipe each listed Codex account's web session that has NO record.
 * A sign-in cut short (a quit between its Cancel and its window closing, say)
 * can leave a session in the partition with no record, and with no record no
 * Sign out is offered, so nothing may stay signed in under it.
 *   - The record store is read ONCE by the caller, without side effects; unless
 *     it read cleanly (or is absent) the whole sweep stands down with one log
 *     line, so a corrupt, downgraded or unreadable store never wipes a session
 *     it may hold a record for.
 *   - Only an account whose own partition folder already exists is touched, so
 *     no partition is made at start for a never-used or archived account; a
 *     folder check that throws skips it.
 *   - Each wipe holds the clearing bar and closes the account's panes first, is
 *     bounded, and never throws; the account of a sign-in in flight is skipped.
 *   - The accounts to wipe are chosen, and each one barred, before the first
 *     wait: nothing runs between the record read and the bars, and from then
 *     on a sign-in or a pane on a chosen account is refused until its own wipe
 *     ends, as during any clear. An account not chosen is never touched, so a
 *     sign-in that completes on it while the sweep runs (in the sign-in
 *     window or in the pane) keeps its session and its record.
 * Returns the accounts wiped.
 */
export async function sweepUnrecordedCodexWebSessions(
  accountIds: readonly string[],
  records: CodexWebRecordsForSweep,
  partitionExists: (accountId: string) => boolean,
): Promise<string[]> {
  if (!records.ok) {
    logInfo(`[codex-web] start sweep skipped: the chatgpt.com record store did not read cleanly (${records.why}${records.file ? `: ${records.file}` : ''})`)
    return []
  }
  // Chosen and barred with no wait in between (see above).
  const chosen: Array<{ accountId: string; unbar: () => void }> = []
  for (const accountId of accountIds) {
    if (!isWebSessionAccountId(accountId)) continue
    if (records.accounts.has(accountId)) continue
    if (current.accountId === accountId && inFlight()) continue
    let exists = false
    try { exists = partitionExists(accountId) === true } catch { exists = false }
    if (!exists) continue
    chosen.push({ accountId, unbar: barWhileClearing(accountId) })
  }
  const wiped: string[] = []
  for (const { accountId, unbar } of chosen) {
    try {
      notifyClosing(accountId)
      await wipeCodexPartition(webPartitionForCodexAccount(accountId), accountId)
      wiped.push(accountId)
    } catch (err) {
      logError(`[codex-web] could not clear an unrecorded chatgpt.com session for ${accountId} at start: ${(err as Error)?.message ?? err}`)
    } finally {
      unbar()
    }
  }
  if (wiped.length) logInfo(`[codex-web] cleared ${wiped.length} chatgpt.com session(s) with no record at start`)
  return wiped
}

/**
 * Cancel the in-flight Codex sign-in (the user's Cancel). SCOPED: with an
 * account id, only that account's run is cancelled. The window is hidden at
 * once; the run sees the cancel at its next poll, takes one last look at the
 * identity answer for the diagnostic (bounded), and destroys its own window
 * (this module's only).
 */
export function cancelCodexWebSignIn(accountId?: string): void {
  if (accountId && current.accountId && current.accountId !== accountId) return
  if (!inFlight()) return
  cancelled = true
  try {
    const w = signInWindow.window
    if (w && !w.isDestroyed() && typeof w.hide === 'function') w.hide()
  } catch { /* the window is going anyway */ }
}

/** Stop the in-flight run AND close its window now: a clear, where nothing
 *  may hold the session while it is wiped. */
function stopCodexWebRun(accountId: string): void {
  if (current.accountId && current.accountId !== accountId) return
  if (!inFlight()) return
  cancelled = true
  closeInAppSignInWindow(signInWindow)
}

/**
 * A finished run whose record the IPC layer refused to save (the account was
 * archived or removed meanwhile): its state reads failed, not done.
 */
export function discardCodexWebRun(accountId: string, error: string): void {
  if (current.accountId === accountId && current.phase === 'done') current = { phase: 'failed', accountId, error }
}

/**
 * Forget one Codex account's chatgpt.com web session: sign-out and archive.
 * Bars the account for the whole clear, cancels a run in flight, closes the
 * account's panes, then clears the WHOLE partition (storage, then the HTTP
 * cache). The storage wipe failing THROWS, and the record is only forgotten
 * after it succeeded; a record that cannot be removed throws too. A failed
 * clear never reads as signed out.
 */
export async function clearCodexWebSession(accountId: string): Promise<void> {
  const partition = webPartitionForCodexAccount(accountId)
  const unbar = barWhileClearing(accountId)
  try {
    // CANCEL FIRST: a sign-in for this account may be mid-poll and would
    // otherwise write a fresh session into the partition being cleared.
    stopCodexWebRun(accountId)
    // THEN CLOSE what holds the session: a pane left open could write a
    // response's cookies back after the wipe.
    notifyClosing(accountId)
    await wipeCodexPartition(partition, accountId)
    if (!notifyCleared(accountId)) throw new Error('The chatgpt.com sign-in was cleared, but its record could not be removed. Try again.')
    logInfo(`[codex-web] cleared the chatgpt.com web session for ${accountId}`)
  } finally {
    unbar()
  }
}

/**
 * The accounts service's archive hook (archive-hooks.ts in provider core,
 * wired at start). For a Codex account: bar new sign-ins, clear the web
 * session, and return the release that lifts the bar once the archive settles
 * (an archived account is refused by the registry check from then on; one
 * whose archive failed may sign in again). A clear that fails rejects, which
 * refuses the archive. Any other provider: nothing.
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
  clearing.clear()
  closingHandlers.clear()
  clearedHandlers.clear()
}
