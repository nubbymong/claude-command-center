/**
 * P3.16 (PR-level ADR-009 round 1, C1): the key of a Codex launch folder in
 * the record of what was written while not indexed (indexing-gaps.ts), as
 * main and the transcripts worker both work it out. The parity of Claude's
 * folder window (claude-folder-key.ts): a local Codex session that is not
 * indexed marks the folder it was launched in from the moment it became not
 * indexed until it ends, so a later reader of any rollout whose session_meta
 * records that folder leaves out what was written in that window. That covers
 * the rollouts its own watcher never claims: one another tab took by folder
 * and time, one Codex started inside the session (its /new, a backtrack) with
 * no hook to say so.
 *
 * The folder is the cwd a rollout's session_meta records, the one a session's
 * watcher matches a new rollout by, spelled as normaliseClaudeFolder spells a
 * folder (absolute, forward slashes, no trailing slash, lower case on
 * Windows); the key is a hash of it, short enough for the record's key limit.
 * Round 2 (K2): the folder alone, in every account's realm. A rollout copied
 * into another realm (a Sign in again's history copy) records the same folder,
 * so it is left out in the same windows; an indexed session of any account in
 * that folder has its turns left out while the window is open (toward not
 * indexing).
 *
 * Pure: no file is read here. No default export (project convention).
 */
import { createHash } from 'crypto'
import { normaliseClaudeFolder } from './claude-folder-key'

export const CODEX_FOLDER_KEY_PREFIX = 'codex-folder:'

/** The record's key for the folder `cwd`. */
export function codexFolderKey(cwd: string, platform: NodeJS.Platform = process.platform): string {
  const folder = normaliseClaudeFolder(cwd, platform)
  return CODEX_FOLDER_KEY_PREFIX + createHash('sha256').update(folder).digest('hex').slice(0, 40)
}

/** The folder a rollout's first line records when it is a session_meta that
 *  names one; else null. */
export function codexSessionMetaCwd(line: string): string | null {
  try {
    const evt = JSON.parse(line) as { type?: unknown; payload?: { cwd?: unknown } | null } | null
    if (!evt || evt.type !== 'session_meta' || !evt.payload || typeof evt.payload !== 'object') return null
    const cwd = evt.payload.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : null
  } catch {
    return null
  }
}
