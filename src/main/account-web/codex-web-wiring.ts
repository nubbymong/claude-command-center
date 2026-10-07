/**
 * codex-web-wiring.ts - WP2 PR 4, P4.6 (row 58): how main's start-up wires a
 * Codex account's chatgpt.com web session. Two small functions, so the wiring
 * is tested by calling it (tests/unit/main/codex-web-wiring.test.ts), not only
 * by reading index.ts:
 *   - wireCodexWebArchive(): the archive hook. Called before the accounts
 *     service exists, so no archive runs without clearing the web session.
 *   - wireCodexWebSession(): the codexWeb channels on the app window; before a
 *     wipe the account's panes close and after it the record goes; a pane
 *     opens only for a Codex session whose CURRENT launch lease is on that
 *     account, and closes (telling the renderer why) when that launch ends or
 *     switches account; at start, a Codex account's web session that has no
 *     record is wiped.
 *
 * No default export (project convention).
 */

import { app, type BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { onBeforeAccountArchive } from '../providers/core'
import type { ConsumerLeaseRegistry } from '../providers/core'
import { onCodexWebSessionCleared, onCodexWebSessionClosing, prepareCodexWebArchive, sweepUnrecordedCodexWebSessions } from './codex-web-session'
import { closeCodexAccountPanes, closeCodexAccountPanesWhere } from './account-pane'
import { readCodexWebRecordsForSweep, removeCodexWebSession } from './codex-web-store'
import { webPartitionForCodexAccount } from '../../shared/account-web-session'
import { registerCodexWebHandlers } from '../ipc/codex-web-handlers'
import { getAccountRegistry } from '../provider-account-registry'

/** What the renderer shows when a pane closes because its session no longer
 *  runs under the account. */
const UNBOUND_REASON = 'This session no longer runs under that account (its Codex CLI ended, or it switched account), so its chatgpt.com view closed.'

/** The Codex accounts the registry lists (any lifecycle). */
function registryCodexAccountIds(): string[] {
  try {
    return (getAccountRegistry()?.current()?.accounts ?? []).filter((a) => a.providerId === 'codex').map((a) => a.id)
  } catch {
    return []
  }
}

/** Whether a Codex account's own partition folder already exists, under the
 *  session data folder's Partitions: the start sweep touches only those, so it
 *  never makes a partition. Anything unknown (no session data folder, a check
 *  that throws) answers false. */
export function codexPartitionFolderExists(sessionDataDir: () => string, exists: (path: string) => boolean = existsSync): (accountId: string) => boolean {
  return (accountId) => {
    try {
      const folder = webPartitionForCodexAccount(accountId).replace(/^persist:/, '')
      return exists(join(sessionDataDir(), 'Partitions', folder)) === true
    } catch {
      return false
    }
  }
}

/** Register the archive hook: an archive clears the account's web session
 *  first, and a clear that fails refuses the archive. */
export function wireCodexWebArchive(): void {
  onBeforeAccountArchive(prepareCodexWebArchive)
}

export interface CodexWebWiringDeps {
  getWindow: () => BrowserWindow | null
  /** Whether a session id is a live Codex PTY session. */
  isCodexPtySession: (sessionId: string) => boolean
  /** The one consumer lease registry. */
  leases: () => Pick<ConsumerLeaseRegistry, 'sessionLaunchAccount' | 'subscribe'>
  /** Whether an account's partition folder exists (the start sweep). Absent:
   *  the folder under Electron's session data folder. */
  partitionExists?: (accountId: string) => boolean
}

export function wireCodexWebSession(deps: CodexWebWiringDeps): void {
  /** A session runs under an account when it is a Codex PTY session whose
   *  current launch (its newest session lease) is on that account. */
  const runsUnder = (sessionId: string, accountId: string): boolean =>
    deps.isCodexPtySession(sessionId) && deps.leases().sessionLaunchAccount(sessionId) === accountId
  registerCodexWebHandlers(deps.getWindow, { sessionRunsUnder: runsUnder })
  onCodexWebSessionClosing(closeCodexAccountPanes)
  onCodexWebSessionCleared(removeCodexWebSession)
  // Bound for as long as the launch lasts: any lease change (a session ended,
  // an account switched) closes each pane whose session no longer runs under
  // its account. The renderer is told, and leaves account mode.
  deps.leases().subscribe(() => {
    closeCodexAccountPanesWhere((sessionId, accountId) => {
      try { return !runsUnder(sessionId, accountId) } catch { return true }
    }, UNBOUND_REASON)
  })
  // At start, nothing stays signed in under an account with no record.
  const partitionExists = deps.partitionExists ?? codexPartitionFolderExists(() => app.getPath('sessionData'))
  void sweepUnrecordedCodexWebSessions(registryCodexAccountIds(), readCodexWebRecordsForSweep(), partitionExists)
}
