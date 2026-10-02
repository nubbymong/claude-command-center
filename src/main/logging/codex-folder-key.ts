/**
 * P3.16 (PR-level ADR-009 round 1, C1): the key of a folder of one Codex realm
 * in the record of what was written while not indexed (indexing-gaps.ts), as
 * main and the transcripts worker both work it out. The parity of Claude's
 * folder window (claude-folder-key.ts): a local Codex session that is not
 * indexed marks the folder it was launched in, inside its own realm, from the
 * moment it became not indexed until it ends, so a later reader of any rollout
 * of that realm whose session_meta records that folder leaves out what was
 * written in that window. That covers the rollouts its own watcher never
 * claims: one another tab took by folder and time, one Codex started inside
 * the session (its /new, a backtrack) with no hook to say so.
 *
 * The realm is the sessions folder a rollout lies in (Codex writes
 * `<sessions>/YYYY/MM/DD/rollout-...jsonl`, rollout-lookup.ts); the folder is
 * the cwd its session_meta records, the one a session's watcher matches a new
 * rollout by. Both are spelled as normaliseClaudeFolder spells a folder
 * (absolute, forward slashes, no trailing slash, lower case on Windows); the
 * key is a hash of the two, short enough for the record's key limit.
 *
 * Pure: no file is read here. No default export (project convention).
 */
import { createHash } from 'crypto'
import * as path from 'path'
import { normaliseClaudeFolder } from './claude-folder-key'

export const CODEX_FOLDER_KEY_PREFIX = 'codex-folder:'

/** The record's key for the folder `cwd` of the realm whose sessions folder is
 *  `sessionsDir`. */
export function codexFolderKey(sessionsDir: string, cwd: string, platform: NodeJS.Platform = process.platform): string {
  const realm = normaliseClaudeFolder(sessionsDir, platform)
  const folder = normaliseClaudeFolder(cwd, platform)
  return CODEX_FOLDER_KEY_PREFIX + createHash('sha256').update(`${realm}\0${folder}`).digest('hex').slice(0, 40)
}

/** The sessions folder a rollout at `rolloutPath` lies in: the folder above its
 *  year folder (its day, month and year folders between). */
export function codexRolloutSessionsDir(rolloutPath: string, platform: NodeJS.Platform = process.platform): string {
  const api = platform === 'win32' ? path.win32 : path.posix
  return api.dirname(api.dirname(api.dirname(api.dirname(rolloutPath))))
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
