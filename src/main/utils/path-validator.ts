import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'

/**
 * Validate that a user-supplied path resolves within an allowed root directory.
 * Prevents path traversal attacks (e.g., ../../etc/passwd).
 * Throws an error if the path is outside the allowed root.
 */
export function validatePath(userPath: string, allowedRoot: string): string {
  const resolved = path.resolve(userPath)
  const normalizedRoot = path.resolve(allowedRoot) + path.sep
  if (!resolved.startsWith(normalizedRoot) && resolved !== path.resolve(allowedRoot)) {
    throw new Error(`Path traversal denied: ${userPath} is outside ${allowedRoot}`)
  }
  return resolved
}

/**
 * Validate that a path is within the Claude memory directory (~/.claude/projects/).
 *
 * P2.5: string containment alone only checks the literal path. A symlink or
 * junction planted inside the memory dir could point outside it, so the real
 * (link-resolved) path is re-checked for containment on every op. Destructive
 * ops additionally refuse to act through a symlink at all.
 */
export function validateMemoryPath(userPath: string, opts?: { destructive?: boolean }): string {
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects')
  const resolved = validatePath(userPath, claudeProjectsDir)

  let realRoot: string
  try {
    realRoot = fs.realpathSync.native(claudeProjectsDir)
  } catch {
    // Memory dir doesn't exist yet -> nothing to read/delete; let the caller's
    // own fs op surface a clean ENOENT.
    return resolved
  }
  let realTarget: string
  try {
    realTarget = fs.realpathSync.native(resolved)
  } catch {
    // Target doesn't exist (already gone / not created). String containment
    // stands; the caller's fs op fails cleanly if it is truly absent.
    return resolved
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    throw new Error(`Path traversal denied: ${userPath} resolves outside the memory dir`)
  }

  // Destructive ops (delete / frontmatter rewrite) must never act THROUGH a
  // symlink, even one that currently resolves back inside the root.
  if (opts?.destructive) {
    let isLink = false
    try { isLink = fs.lstatSync(resolved).isSymbolicLink() } catch { /* gone -> caller's op fails cleanly */ }
    if (isLink) {
      throw new Error(`Refusing a destructive op on a symlinked memory entry: ${userPath}`)
    }
  }

  return resolved
}
