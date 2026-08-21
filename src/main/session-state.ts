/**
 * Session State Persistence
 * Saves and restores open sessions across app restarts.
 * Now stores in ResourcesDirectory/CONFIG/ for portability.
 */

import { join } from 'path'
import { readFileSync, existsSync, unlinkSync, renameSync } from 'fs'
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
    atomicWriteSessionState(getSessionStateFile(), state)
    logInfo(`[session-state] Saved ${state.sessions.length} sessions`)
    return true
  } catch (err) {
    console.error('[session-state] Failed to save:', err)
    return false
  }
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
    let state: SessionState
    try {
      state = JSON.parse(data) as SessionState
    } catch (parseErr) {
      // Unreadable CONTENT, not an unreadable FILE: keep it for forensics, start clean.
      const aside = `${file}.corrupt-${Date.now()}`
      try { renameSync(file, aside) } catch { /* best effort; the next save overwrites it */ }
      logError(`[session-state] session-state.json did not parse (${(parseErr as Error)?.message ?? parseErr}); moved aside to ${aside} and starting with no saved sessions`)
      lastLoadFailed = false
      return null
    }
    lastLoadFailed = false

    if (!Array.isArray(state.sessions)) {
      logInfo('[session-state] No sessions array in state; skipping migration')
      return state
    }

    // v1.5: back-fill provider field + claudeOptions on each SavedSession.
    // Strips legacy top-level Claude fields; persists back only if something changed.
    let dirty = false
    const migratedSessions = state.sessions.map((s: any) => {
      const out = migrateConfigToProviderShape(s)
      if (!s.provider || LEGACY_CLAUDE_FIELDS.some(f => f in s)) {
        dirty = true
      }
      return out
    })
    if (dirty) {
      state.sessions = migratedSessions
      try {
        atomicWriteSessionState(getSessionStateFile(), state)
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
