/**
 * Maps a filesystem path to Claude CLI's project-folder naming convention
 * under ~/.claude/projects/. This is used by both the setup handler
 * (to check whether a project is trusted) and the GitHub transcript
 * loader (to locate the active session's JSONL).
 *
 * e.g. C:\Users\jane\repos\app  ->  C--Users-jane-repos-app
 * e.g. /home/jane/repos/app     ->  -home-jane-repos-app
 *
 * Both colons (drive letters on Windows) and path separators collapse to
 * hyphens; repeated separators flatten rather than producing empty
 * segments because the original convention runs the replacements in
 * sequence on the raw string.
 */
export function pathToClaudeProjectFolder(fsPath: string): string {
  return fsPath
    .replace(/:/g, '-')
    .replace(/[\\/]+/g, '-')
}
