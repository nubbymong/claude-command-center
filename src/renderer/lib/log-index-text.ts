/**
 * P3.12 (row 31; left by P3.4): what the onboarding Transparency page's
 * "Index conversation logs" card says is indexed, by the assistants in use:
 * Claude Code's transcripts, Codex's (each Codex account's sessions folder),
 * or both. With Claude Code alone (or neither) it names Claude's. P3.16a (U2):
 * it names what reads the index (the Logs page, and the Memory page's recent
 * sessions from Claude's transcripts) and says that Tokenomics has an index of
 * its own that the switch does not change.
 */
export function logIndexTransparencyText(on: { claude: boolean; codex: boolean }): string {
  const tail = 'Indexing is local; turning it off stops it at once, and turning it on applies to sessions started after.'
  // Tokenomics is not fed by this index: it keeps its own (app knowledge, privacy).
  const own = 'Tokenomics reads them with an index of its own, which this switch does not change.'
  if (on.codex && !on.claude) {
    return `Powers the Logs page by indexing Codex's own transcripts (each Codex account's sessions folder). ${own} ${tail} Your conversations stay in Codex's files either way.`
  }
  if (on.codex && on.claude) {
    return `Powers the Logs page by indexing Claude's own transcripts (~/.claude/projects) and Codex's (each Codex account's sessions folder), and the recent sessions on the Memory page from Claude's. ${own} ${tail} Your conversations stay in their own files either way.`
  }
  return `Powers the Logs page, and the recent sessions on the Memory page, by indexing Claude's own transcripts (~/.claude/projects). ${own} ${tail} Your conversations stay in Claude's files either way.`
}
