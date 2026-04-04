import * as path from 'path'
import * as os from 'os'

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
 */
export function validateMemoryPath(userPath: string): string {
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects')
  return validatePath(userPath, claudeProjectsDir)
}
