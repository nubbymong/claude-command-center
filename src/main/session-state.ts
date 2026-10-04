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
import type { DetachedRemote, SavedSession, SessionState } from '../shared/types'

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
 * A clear still owed (the owner's 2026-10-04 answer; PR 4 review C-S1). A
 * clear the user asked for ("Close sessions", "Don't open", the window closed
 * with no tabs) that could not remove every copy of the set (the file or its
 * .bak held by a virus scanner or a sync tool) is remembered in a small
 * marker beside the file, written atomically, so it outlives the run. While
 * it is there, a load answers as the clear would have (nothing saved, the
 * file unread, the read-failure latch untouched) and tries the removal again;
 * nothing else reads the set back either. The marker goes once every copy is
 * gone, or once a later save has replaced the set: a save that succeeds
 * removes it, and a file whose own savedAt is later than the clear the
 * marker records is that save's, even when the marker could not be removed.
 * A marker that cannot be read, or holds no time, counts as owed.
 * `clearOwedThisRun` holds the same for this run when the marker could not
 * be written.
 */
function getSessionStateClearOwedFile(): string {
  return `${getSessionStateFile()}.clear-owed`
}

let clearOwedThisRun = false

type ClearOwed = { owed: false } | { owed: true; clearedAt: number | null }

function readClearOwed(): ClearOwed {
  if (clearOwedThisRun) return { owed: true, clearedAt: null }
  let text: string
  try {
    text = readFileSync(getSessionStateClearOwedFile(), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { owed: false }
    return { owed: true, clearedAt: null }
  }
  try {
    const parsed = JSON.parse(text) as { clearedAt?: unknown } | null
    const at = parsed && typeof parsed === 'object' ? parsed.clearedAt : undefined
    if (typeof at === 'number' && Number.isFinite(at)) return { owed: true, clearedAt: at }
  } catch { /* not JSON: owed, with no time */ }
  return { owed: true, clearedAt: null }
}

/** The file on disk was saved after the clear at `clearedAt` (its own
 *  savedAt is later). Only reads: no latch, nothing moved aside. */
function savedAfter(clearedAt: number): boolean {
  try {
    const state = parseSessionStateText(readFileSync(getSessionStateFile(), 'utf-8'))
    return !!state && typeof state.savedAt === 'number' && state.savedAt > clearedAt
  } catch {
    return false
  }
}

/** Remember, on disk and for this run, that the clear is still owed. */
function markClearOwed(): void {
  clearOwedThisRun = true
  try {
    atomicWriteFileSync(getSessionStateClearOwedFile(), JSON.stringify({ clearedAt: Date.now() }))
  } catch (err) {
    logError(`[session-state] the clear is still owed, but that could not be written down for the next start (this run still holds it): ${(err as Error)?.message ?? err}`)
  }
}

/** The clear is no longer owed: every copy is gone, or a save replaced the set. */
function dropClearOwed(): void {
  clearOwedThisRun = false
  try {
    unlinkSync(getSessionStateClearOwedFile())
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') logError(`[session-state] the note that a clear was owed could not be removed (a file saved after that clear is still loaded): ${(err as Error)?.message ?? err}`)
  }
}

/** Whether the file on disk is still a set the user cleared. Only reads. */
function clearStillOwed(): boolean {
  const owed = readClearOwed()
  return owed.owed && (owed.clearedAt === null || !savedAfter(owed.clearedAt))
}

/**
 * The load's side of a clear still owed: retry the removal. True while the
 * set is still on disk (the caller answers nothing). Never reads the set for
 * the caller and never touches the read-failure latch.
 */
function settleOwedClear(): boolean {
  const owed = readClearOwed()
  if (!owed.owed) return false
  if (owed.clearedAt !== null && savedAfter(owed.clearedAt)) {
    dropClearOwed()
    return false
  }
  const done = removeSavedCopies()
  if (done.ok && done.bakRemoved) {
    dropClearOwed()
    logInfo('[session-state] a clear still owed is done: the cleared sessions are removed from disk')
    return false
  }
  logError('[session-state] a clear is still owed (the cleared sessions are still on disk), so none are offered; the removal is tried again at the next load')
  return true
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
 * The detached-remote registry as PERSISTED, for main-side consistency checks
 * (#54: does the saved config a renderer names still reach the destination the
 * registry recorded for a session?). Deliberately NOT `loadSessionState()`: that
 * carries the read-failure latch and the unparseable-file move-aside, and a
 * check inside an IPC handler must never change what the next real load sees.
 * Fail-open to [] on any failure -- the check is additive, so "no record" means
 * "nothing to compare", and the caller falls back to the config-only rule.
 */
export function readDetachedRemotesRegistry(): DetachedRemote[] {
  try {
    // A set the user cleared, still on disk (C-S1): as after the clear, no record.
    if (clearStillOwed()) return []
    const file = getSessionStateFile()
    if (!existsSync(file)) return []
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { detachedRemotes?: unknown } | null
    const list = parsed?.detachedRemotes
    if (!Array.isArray(list)) return []
    return list.filter((e): e is DetachedRemote =>
      !!e && typeof e === 'object' && !Array.isArray(e)
      && typeof (e as DetachedRemote).sessionId === 'string'
      && typeof (e as DetachedRemote).host === 'string'
      && typeof (e as DetachedRemote).username === 'string'
      && typeof (e as DetachedRemote).remotePath === 'string')
  } catch {
    return []
  }
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
    // Fixer 11 (ADR-009 R2-3): and the older .bak is removed. A damaged file
    // would otherwise bring that older set back, a set the user has since cleared
    // among them; with no .bak, a damaged file is moved aside and nothing returns.
    // One that can be neither written nor removed (held by a scanner or a sync
    // tool) is left, and the log says what it holds.
    const bak = getSessionStateBakFile()
    try {
      copyFileSync(file, bak)
    } catch (bakErr) {
      logError(`[session-state] .bak mirror copy failed (previous-good may be stale): ${(bakErr as Error)?.message ?? bakErr}`)
      try {
        if (existsSync(bak)) unlinkSync(bak)
      } catch (rmErr) {
        if ((rmErr as NodeJS.ErrnoException)?.code !== 'ENOENT') logError(`[session-state] the older .bak could not be removed either; until a save copies over it, a damaged session-state.json would recover that older state: ${(rmErr as Error)?.message ?? rmErr}`)
      }
    }
    logInfo(`[session-state] Saved ${state.sessions.length} sessions`)
    // The saved state replaces a set the user cleared: no clear is owed (C-S1).
    dropClearOwed()
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
 * that refuses the next save/clear. While a clear is still owed (C-S1, above)
 * it answers null as that clear would have, after trying the removal again,
 * with the file unread and the latch untouched: the `session:load` path and
 * the GitHub sidebar's reads alike.
 */
export function loadSessionState(): SessionState | null {
  if (settleOwedClear()) return null
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
 * The saved state as the GitHub sidebar reads it (PR 4 follow-up to review
 * C-Q2): a pure read with respect to the save guard. It never sets or resets
 * the read-failure latch, so only the real load (`session:load`) decides
 * whether saves and clears are allowed; it moves nothing aside, recovers
 * nothing from the .bak and writes nothing (entries are put in the provider
 * shape in memory only, and malformed ones dropped, as the load does). Null
 * when nothing is saved, or while a clear is still owed (C-S1). Throws when
 * the file is there but cannot be read or does not parse: the caller then
 * has nothing, and writes nothing.
 */
export function peekSessionState(): SessionState | null {
  if (clearStillOwed()) return null
  const file = getSessionStateFile()
  if (!existsSync(file)) return null
  const state = parseSessionStateText(readFileSync(file, 'utf-8'))
  if (!state) throw new Error('session-state.json did not parse')
  const sessions: SavedSession[] = []
  for (const s of state.sessions as unknown[]) {
    if (!s || typeof s !== 'object') continue
    try {
      sessions.push(migrateConfigToProviderShape(s))
    } catch {
      sessions.push(s as SavedSession)
    }
  }
  return { ...state, sessions }
}

/** What a clear did: `ok`, the saved state is cleared; `bakRemoved`, no
 *  previous-good copy of it (the .bak) is left: false only when one was there
 *  and could not be removed (or the clear was refused or failed). `refused`
 *  (PR 4 review C-Q1): the read-failure latch refused it, so nothing was
 *  tried and no clear is owed: the file was never read, and it stays until a
 *  load reads it. */
export interface SessionStateCleared {
  ok: boolean
  bakRemoved: boolean
  refused?: boolean
}

/**
 * Clear saved session state (called after successful restore). Refused while
 * the last load was a read failure -- never delete what could not be read.
 * Fixer 10 (ADR-009 C2): says whether the .bak was removed, so the caller
 * writes nothing in front of a copy of the set that is still there. A clear
 * that leaves a copy is still owed, remembered across a restart (C-S1); one
 * that removes every copy ends any clear still owed.
 */
export function clearSessionState(): SessionStateCleared {
  if (lastLoadFailed) {
    logError('[session-state] refusing to clear: the last load of session-state.json FAILED (not absent)')
    return { ok: false, bakRemoved: false, refused: true }
  }
  const done = removeSavedCopies()
  if (done.ok && done.bakRemoved) dropClearOwed()
  else markClearOwed()
  return done
}

/** Remove the saved file and then its .bak: what a clear does, and what a
 *  clear still owed retries. The .bak is left when the file could not go. */
function removeSavedCopies(): SessionStateCleared {
  try {
    const file = getSessionStateFile()
    if (existsSync(file)) {
      unlinkSync(file)
      logInfo('[session-state] Cleared saved state')
    }
    // #397 N1: remove the previous-good mirror too. Leaving it behind would keep a
    // copy of the discarded set (cwds, machine names, GitHub config) on disk, and a
    // later corrupt-primary load could recover the PRE-clear set the user discarded.
    // Best effort: one that is held (a scanner, a sync tool) is left, logged and
    // said to the caller; with no primary file it is never read.
    let bakRemoved = true
    const bak = getSessionStateBakFile()
    try {
      if (existsSync(bak)) unlinkSync(bak)
    } catch (bakErr) {
      bakRemoved = (bakErr as NodeJS.ErrnoException)?.code === 'ENOENT'
      if (!bakRemoved) logError(`[session-state] the .bak copy of the cleared state could not be removed: ${(bakErr as Error)?.message ?? bakErr}`)
    }
    return { ok: true, bakRemoved }
  } catch (err) {
    console.error('[session-state] Failed to clear:', err)
    return { ok: false, bakRemoved: false }
  }
}

/**
 * Whether there is a saved session to restore (fixer 10, gate 3 quality nit
 * 2): true only when the saved state holds at least one session, as a load
 * would offer it (the file's sessions, or its .bak's when the file does not
 * parse). A file with none (the conversations' running times kept after a
 * clear, or only remotes left running) is nothing to restore, and neither is
 * one that is absent or cannot be read. Only reads: no latch, nothing moved
 * aside (loadSessionState is the load).
 */
export function hasSavedSessionState(): boolean {
  const restorable = (state: SessionState | null): boolean =>
    !!state && state.sessions.some((s) => !!s && typeof s === 'object')
  try {
    // A set the user cleared, still on disk (C-S1), is nothing to restore.
    if (clearStillOwed()) return false
    const file = getSessionStateFile()
    if (!existsSync(file)) return false
    const state = parseSessionStateText(readFileSync(file, 'utf-8'))
    if (state) return restorable(state)
    const bak = getSessionStateBakFile()
    return existsSync(bak) && restorable(parseSessionStateText(readFileSync(bak, 'utf-8')))
  } catch {
    return false
  }
}
