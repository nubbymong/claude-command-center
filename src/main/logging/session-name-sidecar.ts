/**
 * session-name-sidecar.ts — carry a CCC session's display name across to the
 * transcript on disk, so the name survives outside CCC and identifies which
 * conversation is which during a resume (#536).
 *
 * WHY a sidecar and NOT a line inside Claude's `<uuid>.jsonl`: Claude owns that
 * transcript's format and rewrites it on resume — appending to it risks breaking
 * the very resume we protect (#535). Instead we write a CCC-owned sibling file
 * `<uuid>.ccc-name.json` next to the transcript. It couples to nothing Claude
 * parses, survives worktree/cross-account moves of the projects tree, and the
 * resume-picker reads it in preference to the fragile last-writer-wins
 * uuid->customName map it derives from session-state.json.
 *
 * Every operation is BEST-EFFORT: a name is a convenience, never worth throwing
 * into a spawn / rename / bind path. All I/O is injected so the logic is
 * unit-testable without disk. No default export (project convention).
 *
 * P3.12 (row 32): the same file is written next to a Codex rollout
 * (writeRealmNameSidecar), inside the account's own sessions folder and never
 * through a link; Codex's picker prefers it as Claude's does.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'

/** The sidecar file for a `<uuid>.jsonl` transcript, or null if the path is not a transcript. */
export function sidecarPathFor(transcriptPath: string): string | null {
  if (typeof transcriptPath !== 'string' || !transcriptPath.endsWith('.jsonl')) return null
  return `${transcriptPath.slice(0, -'.jsonl'.length)}.ccc-name.json`
}

export interface NameSidecarDeps {
  writeFile: (p: string, data: string) => void
  readFile: (p: string) => string
  removeFile: (p: string) => void
  /** Epoch ms; injected so tests are deterministic. */
  now: () => number
}

/**
 * Write (or clear) the sidecar next to a transcript. An empty/blank name REMOVES
 * the sidecar (a rename back to the default should not leave a stale name). Never
 * throws — a failure just means the picker falls back to its session-state map.
 */
export function writeNameSidecar(transcriptPath: string, name: string, deps: NameSidecarDeps): void {
  try {
    const p = sidecarPathFor(transcriptPath)
    if (!p) return
    const trimmed = typeof name === 'string' ? name.trim() : ''
    if (!trimmed) {
      try { deps.removeFile(p) } catch { /* best-effort: nothing to clear */ }
      return
    }
    // JSON.stringify escapes every control/quote character in the name, so an
    // arbitrary user rename cannot break the file or inject structure.
    deps.writeFile(p, JSON.stringify({ name: trimmed, updatedAt: deps.now() }))
  } catch {
    /* best-effort: a name is never worth throwing */
  }
}

/** Read the CCC name from a transcript's sidecar, or null (missing / bad / blank). Never throws. */
export function readNameSidecar(transcriptPath: string, deps: Pick<NameSidecarDeps, 'readFile'>): string | null {
  try {
    const p = sidecarPathFor(transcriptPath)
    if (!p) return null
    const parsed = JSON.parse(deps.readFile(p))
    const name = parsed && typeof parsed.name === 'string' ? parsed.name.trim() : ''
    return name || null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Pending-name registry — bridges "renamed before the transcript is bound"
// ---------------------------------------------------------------------------
//
// A rename can land before the binder knows this session's transcript path (the
// exact bind arrives ~20s in, or later). We remember the latest name per CCC
// sessionId; the rename handler writes the sidecar immediately when a path is
// already known, and the binder's exact-bind callback writes it (from this
// registry) the moment the path becomes known. Last write wins, by design.

const pendingNames = new Map<string, string>()

/**
 * Hard cap on remembered names. The rename IPC is reachable by the (less-trusted)
 * renderer with an arbitrary sessionId, so without a bound a compromised renderer
 * could grow this map without limit. Entries are retired on exact-bind and on
 * endRun; the cap is a belt-and-suspenders backstop that evicts the oldest entry
 * (Map preserves insertion order) so the map can never grow unbounded regardless.
 */
const MAX_PENDING_NAMES = 512

/** Record the latest display name for a CCC session (empty string = cleared). */
export function rememberSessionName(sessionId: string, name: string): void {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (!trimmed) { pendingNames.delete(sessionId); return }
  // Re-insert last (refresh recency) and evict the oldest over the cap.
  pendingNames.delete(sessionId)
  pendingNames.set(sessionId, trimmed)
  while (pendingNames.size > MAX_PENDING_NAMES) {
    const oldest = pendingNames.keys().next().value
    if (oldest === undefined) break
    pendingNames.delete(oldest)
  }
}

/** The remembered name for a session, or null. */
export function getRememberedName(sessionId: string): string | null {
  return pendingNames.get(sessionId) ?? null
}

/** Drop a session's remembered name (call when the run ends). */
export function forgetSessionName(sessionId: string): void {
  pendingNames.delete(sessionId)
}

/** Production I/O: node fs, real clock. Injected into the write/read helpers at the call sites. */
export const nodeNameSidecarDeps: NameSidecarDeps = {
  writeFile: (p, data) => { fs.writeFileSync(p, data, 'utf-8') },
  readFile: (p) => fs.readFileSync(p, 'utf-8'),
  removeFile: (p) => { fs.rmSync(p, { force: true }) },
  now: () => Date.now(),
}

// ---------------------------------------------------------------------------
// The name file next to a Codex rollout (P3.12, row 32)
// ---------------------------------------------------------------------------

/** The file-system surface the realm writer uses (injected for tests). */
export interface RealmNameFs {
  /** What is at `p`, not following a link; null when nothing is. */
  lstat: (p: string) => { isFile(): boolean; isDirectory(): boolean } | null
  /** Create `p` new (fails if anything is there, a link included). */
  createExclusive: (p: string, data: string) => void
  rename: (from: string, to: string) => void
  unlink: (p: string) => void
  randomHex: () => string
  now: () => number
}

/** A Codex rollout's own file name. */
const ROLLOUT_NAME_RE = /^rollout-[^\\/]+\.jsonl$/

/** Whether `dir` is `sessionsDir`'s YYYY/MM/DD day folder, every folder from
 *  `sessionsDir` down a real folder (not a link or junction to one), as the
 *  rollout watcher's own check (P3.5). Both are resolved paths. The day-folder
 *  rule is the containment too: a folder outside `sessionsDir` is reached
 *  through `..` (or, on Windows, is on another drive), never through three
 *  names of four, two and two digits. */
function realDayFolder(sessionsDir: string, dir: string, fsi: RealmNameFs): boolean {
  const parts = path.relative(sessionsDir, dir).split(path.sep)
  if (parts.length !== 3 || !/^\d{4}$/.test(parts[0]) || !/^\d{2}$/.test(parts[1]) || !/^\d{2}$/.test(parts[2])) return false
  let at = sessionsDir
  if (!fsi.lstat(at)?.isDirectory()) return false
  for (const part of parts) {
    at = path.join(at, part)
    if (!fsi.lstat(at)?.isDirectory()) return false
  }
  return true
}

/**
 * Write (or, for a blank name, remove) the name file next to a Codex rollout
 * (`rollout-...jsonl` -> `rollout-....ccc-name.json`), the file both pickers
 * read. Only inside `sessionsDir`'s own real day folders; a name-file entry
 * that is not a plain file (a link, a folder) is left alone; the content is
 * written to a file created new beside it and renamed into place, so a link
 * put there is replaced, never written through. Codex, and every reader in
 * the app, lists only `rollout-*.jsonl`, so neither file is taken for a
 * rollout. True when the name file now says `name`. Never throws.
 */
export function writeRealmNameSidecar(rolloutPath: string, sessionsDir: string, name: string, fsi: RealmNameFs): boolean {
  try {
    if (typeof rolloutPath !== 'string' || typeof sessionsDir !== 'string') return false
    const resolved = path.resolve(rolloutPath)
    if (!ROLLOUT_NAME_RE.test(path.basename(resolved))) return false
    const target = sidecarPathFor(resolved)
    if (!target) return false
    const dir = path.dirname(resolved)
    if (!realDayFolder(path.resolve(sessionsDir), dir, fsi)) return false
    const existing = fsi.lstat(target)
    if (existing && !existing.isFile()) return false
    const trimmed = typeof name === 'string' ? name.trim() : ''
    if (!trimmed) {
      if (existing) fsi.unlink(target)
      return true
    }
    const tmp = `${target}.${fsi.randomHex()}.tmp`
    fsi.createExclusive(tmp, JSON.stringify({ name: trimmed, updatedAt: fsi.now() }))
    try {
      fsi.rename(tmp, target)
    } catch {
      try { fsi.unlink(tmp) } catch { /* already gone */ }
      return false
    }
    return true
  } catch {
    return false
  }
}

/** Production I/O for writeRealmNameSidecar: node fs, owner-only new files. */
export const nodeRealmNameFs: RealmNameFs = {
  lstat: (p) => {
    try { return fs.lstatSync(p) } catch { return null }
  },
  createExclusive: (p, data) => { fs.writeFileSync(p, data, { encoding: 'utf-8', flag: 'wx', mode: 0o600 }) },
  rename: (from, to) => { fs.renameSync(from, to) },
  unlink: (p) => { fs.unlinkSync(p) },
  randomHex: () => randomBytes(8).toString('hex'),
  now: () => Date.now(),
}
