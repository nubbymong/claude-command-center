/**
 * The shared null-vs-failed pattern for main-side persisters.
 *
 * A failed READ is not an absence. A file may be there and unreadable for a
 * moment — an AV scanner holding a just-written file (EBUSY), a permissions
 * hiccup, a network share that blinked — and a loader that answers `null` for
 * that exactly as it answers for "no file" hands its caller an empty store.
 * The caller then does the ordinary thing with an empty store (adds one item,
 * cleans up a stuck entry, saves the form the user just opened) and writes it
 * over the file it never managed to read. The user's cloud agents, team
 * library, usage history, vision settings or window geometry are gone, and
 * nothing failed loudly.
 *
 * `session-state.ts` fixed this shape for saved sessions in the ADR-009 pass
 * before beta.16 (#353), and that pass left a note: the same shape is in five
 * other main-side persisters, and it wanted ONE shared fix rather than five
 * copies of the same latch. This module is that fix (#371).
 *
 * The rule, in one line: **while the last load was a read failure, the file on
 * disk outranks anything in memory that never saw it.**
 *
 * Three outcomes, not two:
 *
 *   - **absent** — there is genuinely no file. An empty store is the truth.
 *     Writes allowed.
 *   - **unparseable** — the file read fine and its CONTENT is unrecoverable.
 *     It is moved aside (never silently destroyed) so the store can start
 *     clean. Writes allowed — there is nothing left to protect.
 *   - **failed** — the file could not be read. Writes are REFUSED until a
 *     later load succeeds, which clears the latch.
 *
 * Note the asymmetry that makes this safe to apply everywhere: a refused write
 * costs one unsaved change, which the next successful load un-refuses. An
 * un-refused write costs the file.
 */

import { logError, logInfo } from './debug-logger'
import { readConfigChecked, writeConfig, type ConfigKey, type ConfigReadOutcome } from './config-manager'

export interface ReadFailureLatch {
  /** Name used in log lines — the persister, not the file. */
  readonly name: string
  /** True while the last load was a read FAILURE (not an absence). */
  failed(): boolean
  /** Record a load outcome. Anything other than `failed` clears the latch. */
  note(outcome: ConfigReadOutcome): void
  /**
   * The write gate. Returns true when the caller must NOT write, and logs why.
   * `action` names what is being refused ('save', 'clear', …) so the log line
   * reads as a sentence.
   */
  refuses(action: string): boolean
  /** Test seam — a module-level latch outlives a test otherwise. */
  reset(): void
}

export function createReadFailureLatch(name: string): ReadFailureLatch {
  let lastLoadFailed = false
  return {
    name,
    failed: () => lastLoadFailed,
    note(outcome: ConfigReadOutcome) {
      lastLoadFailed = outcome === 'failed'
    },
    refuses(action: string): boolean {
      if (!lastLoadFailed) return false
      logError(
        `[${name}] refusing to ${action}: the last load FAILED to read the file (it was not absent), ` +
          `so what is on disk is kept rather than overwritten by a state that never saw it`,
      )
      return true
    },
    reset() {
      lastLoadFailed = false
    },
  }
}

/**
 * Read a config key through a latch. Returns the parsed value, or null for
 * "absent", "unparseable" and "failed" alike — the failure signal rides on the
 * latch, never on the return value, so callers keep their existing shape and
 * only have to consult the latch before they WRITE.
 */
export function loadConfigLatched<T = unknown>(key: ConfigKey, latch: ReadFailureLatch): T | null {
  const read = readConfigChecked<T>(key)
  latch.note(read.outcome)
  if (read.outcome === 'failed') {
    logInfo(`[${latch.name}] ${key} could not be read; writes are refused until a load succeeds`)
  }
  return read.value
}

/**
 * Write a config key through a latch. Refuses while the latch is set, and
 * reports the refusal as a failed write — a caller that surfaces "saved" to the
 * user must not claim success for a write that never happened.
 */
export function saveConfigLatched(key: ConfigKey, value: unknown, latch: ReadFailureLatch, action = 'save'): boolean {
  if (latch.refuses(action)) return false
  return writeConfig(key, value)
}
