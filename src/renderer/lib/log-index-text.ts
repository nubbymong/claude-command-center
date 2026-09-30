/**
 * P3.12 (row 31; left by P3.4): what the onboarding Transparency page's
 * "Index conversation logs" card says is indexed, by the assistants in use:
 * Claude Code's transcripts, Codex's (each Codex account's sessions folder),
 * or both. With Claude Code alone (or neither) the text is as it was.
 */
export function logIndexTransparencyText(on: { claude: boolean; codex: boolean }): string {
  const tail = 'Indexing is local; turning it off stops it at once, and turning it on applies to sessions started after.'
  if (on.codex && !on.claude) {
    return `Powers the Logs page by indexing Codex's own transcripts (each Codex account's sessions folder). ${tail} Your conversations stay in Codex's files either way.`
  }
  if (on.codex && on.claude) {
    return `Powers the Logs, Memory and Tokenomics pages by indexing Claude's own transcripts (~/.claude/projects) and Codex's (each Codex account's sessions folder). ${tail} Your conversations stay in their own files either way.`
  }
  return `Powers the Logs, Memory and Tokenomics pages by indexing Claude's own transcripts (~/.claude/projects). ${tail} Your conversations stay in Claude's files either way.`
}
