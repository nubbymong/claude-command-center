/**
 * brief-file.ts — write a generated brief into the session's working directory (#209).
 *
 * The brief lands at `<workingDirectory>/.claude/imports/<generated-name>.md`.
 *
 * Why inside the working directory rather than CCC's own data dir: the new session
 * has to READ this file on its first turn. A path inside the cwd is read without
 * friction; a path outside it is not. `.claude/` is already the Claude-owned
 * directory in a project, so this adds nothing new to the repo's shape.
 *
 * SECURITY: the file NAME is generated entirely by CCC (timestamp + random hex) —
 * nothing from the transcript, the chat title, or the renderer reaches it. The
 * resolved destination is re-checked to be inside the resolved working directory
 * before any write, so a crafted `workingDirectory` cannot escape via traversal.
 *
 * No default export (project convention).
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { WrittenBrief } from '../../shared/desktop-import'

/** `.claude/imports` — relative, forward-slashed for display. */
export const IMPORT_DIR_RELATIVE = '.claude/imports'

/**
 * CCC-generated, collision-resistant, traversal-proof by construction:
 * `desktop-chat-YYYYMMDD-HHMMSS-<8 hex>.md`.
 */
export function generateBriefFileName(now = new Date(), rand = () => randomBytes(4).toString('hex')): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  return `desktop-chat-${stamp}-${rand()}.md`
}

/**
 * True when `child` resolves to `parent` itself or something beneath it. Compared
 * on resolved absolute paths with a trailing separator so `/a/bc` is not treated
 * as being inside `/a/b`.
 */
export function isInside(parent: string, child: string): boolean {
  const p = resolve(parent)
  const c = resolve(child)
  if (c === p) return true
  return c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/**
 * Write `markdown` into `<workingDirectory>/.claude/imports/`.
 *
 * Throws when the working directory is missing / not a directory, or when the
 * computed destination would fall outside it. The caller (the IPC handler) turns
 * a throw into a user-visible error — a failed write must never silently produce
 * a session primed to read a file that does not exist.
 */
export function writeBriefFile(
  workingDirectory: string,
  markdown: string,
  fileName = generateBriefFileName(),
): WrittenBrief {
  const root = resolve(workingDirectory)
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`working directory does not exist: ${workingDirectory}`)
  }

  const dir = join(root, '.claude', 'imports')
  const target = join(dir, fileName)
  // Pinned to the IMPORTS dir, not merely to the working directory: a `../..`
  // name climbs out of `.claude/imports` while still landing inside the repo,
  // which a root-only check would wave through.
  if (!isInside(dir, target)) {
    throw new Error('refusing to write the brief outside .claude/imports')
  }

  mkdirSync(dir, { recursive: true })
  writeFileSync(target, markdown, 'utf-8')

  return { path: target, relativePath: `${IMPORT_DIR_RELATIVE}/${fileName}` }
}
