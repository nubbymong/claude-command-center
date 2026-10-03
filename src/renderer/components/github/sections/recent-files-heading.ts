/**
 * P3.12 round 1 (A4): the heading of the GitHub Session Context's recent
 * files, naming the session's own assistant (the context reports it).
 */
export function recentFilesHeading(assistant: 'claude' | 'codex' | undefined): string {
  return assistant === 'codex' ? 'Codex recently edited:' : 'Claude recently edited:'
}
