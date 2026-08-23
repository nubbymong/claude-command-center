/**
 * Session State Persistence
 * Saves and restores open sessions across app restarts.
 * Now stores in ResourcesDirectory/CONFIG/ for portability.
 */

import { join } from 'path'
import { readFileSync, existsSync, unlinkSync, renameSync, copyFileSync } from 'fs'
import { getConfigDir, ensureConfigDir, migrateConfigToProviderShape } from './config-manager'
import { logInfo, logError } from './debug-logger'
import { atomicWriteFileSync } from './atomic-write'
import type { SavedSession, SessionState } from '../shared/types'

export type { SavedSession, SessionState }

// Legacy top-level Claude fields that get migrated into claudeOptions.
// Mirrors CLAUDE_FIELDS in config-manager.ts for the SavedSession case.
const LEGACY_CLAUDE_FIELDS = ['model', 'effortLevel', 'legacyVersion', 'disableAutoMemory', 'agentIds'] as const

// Lazy getter -- can't call getConfigDir() at module load time
function getSessionStateFile(): string {
  return join(getConfigDir(), 'session-state.json')
}

// #397 Group 3: a previous-good mirror of session-state.json. Written after every
// successful save; read back only when the primary file exists but does NOT parse.
// Atomic writes already rule out a partial write, so this guards the OTHER way the
// file goes bad -- external corruption (an AV scanner, a disk fault, a bad edit) --
// so a corrupt primary recovers the last-good set instead of losing every session.
function getSessionStateBakFile(): string {
  return `${getSessionStateFile()}.bak`
}

/**
 * A failed READ is not an absence. The file may be there and unreadable for a
 * moment -- an AV scanner holding a just-written file (EBUSY), a permissions
 * hiccup, a network share that blinked -- and `loadSessionState()` used to
 * answer `null` for that exactly as for "no file". The renderer then saw "no
 * saved sessions", showed no Resume prompt, and at close wrote the EMPTY
 * session list over the saved one: the one thing session-state.json exists to
 * survive. So the last load's outcome is remembered, and while it was a
 * failure this module refuses to save or clear -- the file on disk, whatever
 * it holds, outranks an in-memory state that never saw it. A later successful
 * load clears the latch. This is the main-process twin of the renderer's
 * config-write latch (#341/#353).
 *
 * A file that reads fine but does not PARSE is different: its content is
 * unrecoverable, so it is moved aside (never silently destroyed) and the
 * store starts clean -- saving is allowed again, nothing is overwritten.
 */
let lastLoadFailed = false

/** True while the last `loadSessionState()` was a read failure (not an absence). */
export function sessionStateReadFailed(): boolean {
  return lastLoadFailed
}

/**
 * Atomic write for session-state.json, via the shared helper (#233). A crash
 * mid-write leaves the previous file intact, never a partially-written one.
 *
 * P7.7.16: the earlier copyFileSync-when-target-exists branch was NOT
 * atomic -- copyFileSync truncates the destination in-place and then
 * writes, so a crash mid-copy would leave session-state.json corrupted.
 * The Copilot review on 6384814 (P7.7.14) caught this.
 */
function atomicWriteSessionState(filePath: string, state: SessionState): void {
  // Staging, exclusive create, retry and cleanup all live in atomic-write.ts
  // (#233). Still rethrows, so the caller's contract is unchanged.
  atomicWriteFileSync(filePath, JSON.stringify(state, null, 2))
}

/**
 * Save current session state to disk. Refused (false, logged) while the last
 * load was a read failure -- see the latch note above.
 */
export function saveSessionState(state: SessionState): boolean {
  if (lastLoadFailed) {
    logError('[session-state] refusing to save: the last load of session-state.json FAILED (not absent), so the file on disk is kept rather than overwritten by a state that never saw it')
    return false
  }
  try {
    ensureConfigDir()
    const file = getSessionStateFile()
    atomicWriteSessionState(file, state)
    // #397 Group 3: mirror the just-written (known-good) file to the .bak. Copying
    // AFTER the atomic write -- not the prior file before it -- guarantees the .bak
    // is always a valid, recently-persisted state, never a half-written one. Best
    // effort: a copy failure must not fail the save the user actually asked for.
    // #397 round-2: log a copy failure. A silently-lagged .bak (the copy loses the
    // same EBUSY/AV race the primary write can hit) would let a later recovery
    // reinstate an OLDER set with no trace; the log gives that a trail.
    try {
      copyFileSync(file, getSessionStateBakFile())
    } catch (bakErr) {
      logError(`[session-state] .bak mirror copy failed (previous-good may be stale): ${(bakErr as Error)?.message ?? bakErr}`)
    }
    logInfo(`[session-state] Saved ${state.sessions.length} sessions`)
    return true
  } catch (err) {
    console.error('[session-state] Failed to save:', err)
    return false
  }
}

/**
 * Parse session-state JSON text into a SessionState, tolerating the two content
 * defects that used to lose the WHOLE saved set (#397 Group 3):
 *   - a missing/non-array `sessions` (it reached the renderer and threw on
 *     `.length`, silently dropping the Resume prompt);
 *   - the top-level value not being an object at all.
 * Both are treated as UNPARSEABLE (null), not coerced: the caller then tries
 * the .bak, which either recovers the last-good set or moves the corrupt file
 * aside — so downstream consumers (the canvas session-link's fail-closed
 * "cannot tell whose canvases are current" contract included) never see a
 * shape-corrupt file dressed up as an empty one (#413 review, R4). A single
 * malformed session ENTRY is handled later, per-entry, not here.
 */
function parseSessionStateText(text: string): SessionState | null {
  let state: SessionState
  try {
    state = JSON.parse(text) as SessionState
  } catch {
    return null
  }
  if (!state || typeof state !== 'object') return null
  if (!Array.isArray(state.sessions)) return null
  return state
}

/**
 * Load saved session state from disk. `null` means "no saved sessions" ONLY
 * when the file is absent or was unparseable-and-moved-aside; a read failure
 * also returns null (the caller's contract is unchanged) but sets the latch
 * that refuses the next save/clear.
 */
export function loadSessionState(): SessionState | null {
  const file = getSessionStateFile()
  try {
    if (!existsSync(file)) {
      lastLoadFailed = false
      return null
    }
    const data = readFileSync(file, 'utf-8')
    let state = parseSessionStateText(data)
    if (!state) {
      // The primary file exists but its CONTENT does not parse. Before starting
      // clean, try the .bak previous-good mirror (#397 Group 3) so external
      // corruption of the primary recovers the last-good set instead of losing it.
      const bak = getSessionStateBakFile()
      let recovered: SessionState | null = null
      try {
        if (existsSync(bak)) recovered = parseSessionStateText(readFileSync(bak, 'utf-8'))
      } catch { /* .bak unreadable too -- fall through to clean start */ }

      const aside = `${file}.corrupt-${Date.now()}`
      try { renameSync(file, aside) } catch { /* best effort; the next save overwrites it */ }
      lastLoadFailed = false

      if (recovered) {
        // Reinstate the recovered set as the primary so the next save has a baseline.
        try { atomicWriteSessionState(file, recovered) } catch { /* best effort */ }
        logError(`[session-state] session-state.json did not parse; RECOVERED ${recovered.sessions.length} sessions from ${bak} (corrupt file moved aside to ${aside})`)
        state = recovered
      } else {
        logError(`[session-state] session-state.json did not parse and no usable .bak exists; moved aside to ${aside} and starting with no saved sessions`)
        return null
      }
    } else {
      lastLoadFailed = false
    }

    // v1.5: back-fill provider field + claudeOptions on each SavedSession.
    // Strips legacy top-level Claude fields; persists back only if something changed.
    // #397 Group 3: guarded PER ENTRY. A null/primitive entry, or a migration that
    // throws on one row, must not throw the whole load away (that used to null the
    // set AND wrongly trip the read-failure latch, refusing all later saves).
    let dirty = false
    const migratedSessions: SavedSession[] = []
    for (const s of state.sessions as any[]) {
      if (!s || typeof s !== 'object') {
        dirty = true // dropping an un-restorable entry changes the set; persist the cleaned one
        logError('[session-state] dropped a malformed (null/non-object) session entry during load')
        continue
      }
      try {
        const out = migrateConfigToProviderShape(s)
        if (!s.provider || LEGACY_CLAUDE_FIELDS.some(f => f in s)) dirty = true
        migratedSessions.push(out)
      } catch (perEntryErr) {
        // Keep the raw entry rather than losing it or nuking the whole set.
        logError(`[session-state] migration failed for one session; keeping it unmigrated: ${(perEntryErr as Error)?.message ?? perEntryErr}`)
        migratedSessions.push(s as SavedSession)
      }
    }
    state.sessions = migratedSessions
    if (dirty) {
      try {
        atomicWriteSessionState(getSessionStateFile(), state)
        try { copyFileSync(getSessionStateFile(), getSessionStateBakFile()) } catch { /* .bak is a bonus */ }
        logInfo('[session-state] Migrated sessions to provider shape')
      } catch (writeErr) {
        logError(`[session-state] migration write failed; in-memory state preserved: ${(writeErr as Error)?.message ?? writeErr}`)
      }
    }

    logInfo(`[session-state] Loaded ${state.sessions.length} sessions from ${new Date(state.savedAt).toLocaleString()}`)
    return state
  } catch (err) {
    // The file is (probably) there and could not be read: EBUSY, EACCES, EPERM,
    // EIO, a junction refusal... This is the case the latch exists for.
    lastLoadFailed = true
    logError(`[session-state] Failed to load (read failure, NOT treated as absent; save/clear refused until a load succeeds): ${(err as Error)?.message ?? err}`)
    return null
  }
}

/**
 * Clear saved session state (called after successful restore). Refused while
 * the last load was a read failure -- never delete what could not be read.
 */
export function clearSessionState(): boolean {
  if (lastLoadFailed) {
    logError('[session-state] refusing to clear: the last load of session-state.json FAILED (not absent)')
    return false
  }
  try {
    const file = getSessionStateFile()
    if (existsSync(file)) {
      unlinkSync(file)
      logInfo('[session-state] Cleared saved state')
    }
    // #397 N1: remove the previous-good mirror too. Leaving it behind would keep a
    // copy of the discarded set (cwds, machine names, GitHub config) on disk, and a
    // later corrupt-primary load could recover the PRE-clear set the user discarded.
    try {
      const bak = getSessionStateBakFile()
      if (existsSync(bak)) unlinkSync(bak)
    } catch { /* best effort; recovery also re-parses + re-sanitizes before any use */ }
    return true
  } catch (err) {
    console.error('[session-state] Failed to clear:', err)
    return false
  }
}

/**
 * Check if there's a saved session state to restore
 */
export function hasSavedSessionState(): boolean {
  return existsSync(getSessionStateFile())
}
