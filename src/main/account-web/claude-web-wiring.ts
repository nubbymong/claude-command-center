/**
 * claude-web-wiring.ts: how main's start-up wires an account's claude.ai web
 * session clears. One small function, so the wiring is tested by calling it
 * (tests/unit/main/claude-web-wiring.test.ts), not only by reading index.ts:
 *   - before any wipe of an account's partition (a sign-out, an account
 *     delete, an unfinished sign-in, the start sweep), its views and its
 *     artifacts window close, so nothing holding the session writes it back
 *     while it is wiped;
 *   - at start, each account's web session that has no record is wiped
 *     (sign-in.ts sweepUnrecordedClaudeWebSessions): the record store is read
 *     once without side effects, and only a partition folder this instance's
 *     own session data folder already holds is touched.
 * The record and the views going AFTER a wipe stay wired through
 * partition-revocation.ts, as before.
 *
 * No default export (project convention).
 */

import { app } from 'electron'
import { listProfiles } from '../account-profiles'
import { closeAccountPanesForProfile } from './account-pane'
import { closeArtifacts } from './artifacts'
import { readClaudeWebRecordsForSweep } from './session-store'
import { claudePartitionFolderExists, onClaudeWebSessionClosing, sweepUnrecordedClaudeWebSessions } from './sign-in'

export interface ClaudeWebWiringDeps {
  /** The account ids to sweep. Absent: the listed account profiles. */
  profileIds?: () => string[]
  /** Whether an account's partition folder exists. Absent: the folder under
   *  Electron's session data folder. */
  partitionExists?: (profileId: string) => boolean
}

/** The listed account profiles' ids; a list that cannot be read is empty. */
function listedProfileIds(): string[] {
  try {
    return listProfiles().map((p) => p.id)
  } catch {
    return []
  }
}

/** Wire the clears and run the start sweep. Never throws; the sweep's result
 *  is not awaited (each wipe is bounded, and logs its own outcome). */
export function wireClaudeWebSession(deps: ClaudeWebWiringDeps = {}): void {
  onClaudeWebSessionClosing((profileId) => closeAccountPanesForProfile(profileId))
  onClaudeWebSessionClosing(closeArtifacts)
  let ids: string[] = []
  try {
    ids = (deps.profileIds ?? listedProfileIds)()
  } catch {
    ids = []
  }
  const partitionExists = deps.partitionExists ?? claudePartitionFolderExists(() => app.getPath('sessionData'))
  let records: ReturnType<typeof readClaudeWebRecordsForSweep>
  try {
    records = readClaudeWebRecordsForSweep()
  } catch {
    records = { ok: false, why: 'unreadable' }
  }
  void sweepUnrecordedClaudeWebSessions(ids, records, partitionExists).catch(() => { /* each wipe logs its own outcome */ })
}
