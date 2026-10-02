/**
 * P3.16 round 1 (N1): the key of a Claude projects folder in the record of
 * what was written while not indexed (indexing-gaps.ts), as main and the
 * transcripts worker both work it out. A local Claude session that is not
 * indexed and has named no transcript yet marks its whole folder (the folder
 * its transcripts go to) from the moment it became not indexed, so a later
 * reader of any transcript there leaves out what was written in that window.
 *
 * The folder is the canonical one the transcript binder binds under
 * (`~/.claude/projects/<cwd, mangled>`); the key is a hash of its normalised
 * spelling (forward slashes, no trailing slash, lower case on Windows), short
 * enough for the record's key limit.
 *
 * P3.16a round 2 (Q2, Q3): the key of the projects folders' root (the folder
 * that holds every project's folder), for a session not indexed that names a
 * transcript of another project's folder after it already holds the most
 * windows a session holds: every transcript in a folder directly under the
 * root is left out for that stretch. A key of its own, so a transcript lying
 * directly in the root is not taken for one in a project's folder.
 *
 * No default export (project convention).
 */
import { createHash } from 'crypto'
import * as path from 'path'

export const CLAUDE_FOLDER_KEY_PREFIX = 'claude-folder:'
export const CLAUDE_PROJECTS_ROOT_KEY_PREFIX = 'claude-projects-root:'

/** The folder's spelling for comparing (absolute, forward slashes, no
 *  trailing slash, lower case on Windows). */
export function normaliseClaudeFolder(dir: string, platform: NodeJS.Platform = process.platform): string {
  const abs = platform === 'win32' ? path.win32.resolve(dir) : path.posix.resolve(dir)
  const slashed = abs.replace(/\\/g, '/').replace(/\/+$/, '')
  return platform === 'win32' ? slashed.toLowerCase() : slashed
}

/** The record's key for the Claude projects folder `dir`. */
export function claudeFolderKey(dir: string, platform: NodeJS.Platform = process.platform): string {
  return CLAUDE_FOLDER_KEY_PREFIX + createHash('sha256').update(normaliseClaudeFolder(dir, platform)).digest('hex').slice(0, 40)
}

/** P3.16a round 2 (Q2, Q3): the record's key for the projects folders' root
 *  `dir` (a transcript's is the folder above its own folder). */
export function claudeProjectsRootKey(dir: string, platform: NodeJS.Platform = process.platform): string {
  return CLAUDE_PROJECTS_ROOT_KEY_PREFIX + createHash('sha256').update(normaliseClaudeFolder(dir, platform)).digest('hex').slice(0, 40)
}
