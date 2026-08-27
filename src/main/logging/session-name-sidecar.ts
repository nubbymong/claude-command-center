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
 */

import * as fs from 'node:fs'

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

/** Record the latest display name for a CCC session (empty string = cleared). */
export function rememberSessionName(sessionId: string, name: string): void {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (trimmed) pendingNames.set(sessionId, trimmed)
  else pendingNames.delete(sessionId)
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
