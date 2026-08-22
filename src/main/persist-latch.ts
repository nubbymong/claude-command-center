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
  /**
   * The generation of the last SUCCESSFUL load. It changes every time a load
   * succeeds, so a caller that built some state from a load can prove, later,
   * that the state it is about to write still comes from the newest reading of
   * the file. A caller holding generation 0 (or any stale one) is holding state
   * that never saw the current file.
   */
  generation(): number
  /** Record a load outcome. Anything other than `failed` clears the latch. */
  note(outcome: ConfigReadOutcome): void
  /**
   * The write gate. Returns true when the caller must NOT write, and logs why.
   * `action` names what is being refused ('save', 'clear', …) so the log line
   * reads as a sentence.
   *
   * Logged once per latch transition rather than per call: `saveSnapshots` runs
   * on every successful usage fetch, so a latched process used to write an
   * error line per poll for its whole lifetime.
   */
  refuses(action: string): boolean
  /** Test seam — a module-level latch outlives a test otherwise. */
  reset(): void
}

export function createReadFailureLatch(name: string): ReadFailureLatch {
  let lastLoadFailed = false
  let generationCounter = 0
  let refusalLogged = false
  return {
    name,
    failed: () => lastLoadFailed,
    generation: () => generationCounter,
    note(outcome: ConfigReadOutcome) {
      const wasFailed = lastLoadFailed
      lastLoadFailed = outcome === 'failed'
      if (outcome === 'failed') return
      refusalLogged = false
      // The generation changes only on RECOVERY — a load that succeeds after a
      // failure. Bumping on every successful load would refuse an ordinary
      // save: reading the file twice between opening a form and saving it is
      // normal, and nothing about the content changed. What a caller needs to
      // detect is precisely "the file was unreadable when I built this state,
      // and it is readable now", because that is when its state is stale.
      if (wasFailed) generationCounter += 1
    },
    refuses(action: string): boolean {
      if (!lastLoadFailed) return false
      if (!refusalLogged) {
        refusalLogged = true
        logError(
          `[${name}] refusing to ${action}: the file could not be read (it was not absent), ` +
            `so what is on disk is kept rather than overwritten by a state that never saw it. ` +
            `Further refusals for this latch are not logged until a load succeeds.`,
        )
      }
      return true
    },
    reset() {
      lastLoadFailed = false
      generationCounter = 0
      refusalLogged = false
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

export interface LatchedSaveOptions {
  /** Names the refused operation in the log ('save', 'clear', …). */
  action?: string
  /**
   * Set false to REFUSE outright instead of retrying the read.
   *
   * The retry exists for stores that can MERGE (a list keyed by id): recover
   * the file, fold it in, write the union. A store whose state is a single
   * object has nothing to merge, so recovering the file only to write the
   * in-memory fallback over it is the loss, not the fix. `window-state` and the
   * vision config are both that shape (#371, ADR-009 pass).
   */
  retry?: boolean
  /**
   * Called when the retry read below RECOVERS a file that had previously failed
   * to read. The owner MUST fold the recovered content back into its in-memory
   * state before the write happens — otherwise the empty store built from the
   * failed load is what lands on the newly readable file, which is the exact
   * loss this whole module exists to prevent.
   *
   * Omit it only when the state being written does not depend on what was on
   * disk (see `window-state.ts`, which refuses outright instead).
   */
  onRecovered?: (recovered: unknown) => void
}

/**
 * Write a config key through a latch.
 *
 * A latched save does NOT simply refuse. It re-reads the file first, because
 * the failures this guards against are transient by nature — an AV scanner
 * holding a file for 50 ms, a share that blinked — and five of the six
 * persisters load exactly once, at boot. Without this retry a single 50 ms lock
 * at startup would disable persistence for the entire process life, which turns
 * a momentary read failure into a guaranteed loss of everything the user does
 * afterwards. Worse than the bug it replaced.
 *
 * So: retry the read; if it now succeeds, hand the recovered content to
 * `onRecovered` so the owner can merge it, then write. A refusal therefore
 * means the file is STILL unreadable, which is the only case worth refusing
 * for.
 *
 * `value` is a thunk so it is evaluated AFTER any recovery — the merged state,
 * not the empty one the caller was holding when it called.
 */
export function saveConfigLatched(
  key: ConfigKey,
  value: unknown | (() => unknown),
  latch: ReadFailureLatch,
  opts: LatchedSaveOptions = {},
): boolean {
  const action = opts.action ?? 'save'
  let justRecovered = false
  if (latch.failed()) {
    if (opts.retry === false) {
      latch.refuses(action)
      return false
    }
    const retry = readConfigChecked(key)
    if (retry.outcome === 'failed') {
      latch.note(retry.outcome)
      latch.refuses(action)
      return false
    }
    logInfo(`[${latch.name}] ${key} is readable again; folding it back in before saving`)
    // Even when the retry says "absent" or "unparseable" the owner is told, so
    // it can decide — `recovered` is null in both cases, which is a truthful
    // answer meaning "there is nothing on disk to merge".
    opts.onRecovered?.(retry.value)
    justRecovered = true
    latch.note(retry.outcome)
  }
  const ok = writeConfig(key, typeof value === 'function' ? (value as () => unknown)() : value)
  if (!ok && justRecovered) {
    // The latch was cleared by the recovery and the WRITE then failed, so the
    // caller is about to roll its in-memory state back — to the PRE-recovery
    // snapshot, which is the small set built from a failed load. With the latch
    // clear, the next save would write that over the file we just proved is
    // readable, report {ok:true}, and lose the lot silently (#371, ADR-009
    // pass). Re-latch: the next save retries the read and merges again.
    latch.note('failed')
    logError(
      `[${latch.name}] ${key} became readable but the write FAILED; re-latching so the next save ` +
        `re-reads and merges rather than overwriting the file with a state built from the failed load`,
    )
  }
  return ok
}

/**
 * Fold a recovered on-disk list back into an in-memory one, keyed on `id`.
 *
 * The disk copy is the truth for everything that existed before the read
 * failed; the in-memory copy is the truth for anything created since, and for
 * any row the user has changed. So: start from disk, then let memory win per
 * id. Anything unrecognisable on disk is dropped rather than trusted.
 */
export function mergeById<T extends { id?: unknown }>(recovered: unknown, inMemory: readonly T[]): T[] {
  if (!Array.isArray(recovered)) return [...inMemory]
  const byId = new Map<string, T>()
  for (const row of recovered as T[]) {
    if (row && typeof row === 'object' && typeof row.id === 'string') byId.set(row.id, row)
  }
  for (const row of inMemory) {
    if (row && typeof row.id === 'string') byId.set(row.id, row)
  }
  return [...byId.values()]
}
