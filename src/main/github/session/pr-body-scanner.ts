/**
 * Scan a PR body for issue references the Session Context algorithm can use
 * as fallback signals.
 *
 * Recognises:
 *   - Plain numeric refs:      `#123`
 *   - Keyword refs:            `closes #123`, `fixes #123`, `resolves #123`
 *   - Cross-repo refs:         `owner/repo#123`  (number extracted)
 *   - GitHub issue/PR URLs:    `https://github.com/owner/repo/issues/123`
 *                              `https://github.com/owner/repo/pull/123`
 *
 * Excludes:
 *   - Numbers inside code fences (``` fenced ```) and inline code (`x`)
 *   - URL fragments (#anchor) — heuristically filtered by requiring a digit
 *     immediately after `#`
 *
 * Returns at most MAX_REFS deduped numbers in first-seen order so the
 * priority algorithm in session-context-service is deterministic.
 */

const MAX_REFS = 10

export function scanPrBodyRefs(body: string | null | undefined): number[] {
  if (!body || typeof body !== 'string') return []
  const stripped = stripCodeRegions(body)
  const seen = new Set<number>()
  const out: number[] = []

  const add = (n: number) => {
    if (!Number.isFinite(n) || n <= 0 || n > 1e9) return
    if (seen.has(n)) return
    seen.add(n)
    out.push(n)
  }

  // GitHub issue/pull URLs
  const urlRe = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/(\d+)/gi
  for (const m of stripped.matchAll(urlRe)) {
    add(Number(m[1]))
    if (out.length >= MAX_REFS) return out
  }

  // owner/repo#N and plain #N (digit required immediately after #).
  // The negative lookbehind for '/' is handled by allowing an optional
  // `word/word` prefix; bare #N is picked up in a second pass by the
  // simpler regex below. Ordering matters: match cross-repo first so its
  // numbers are captured before the bare-#N pass touches them.
  const crossRe = /\b([\w.-]+\/[\w.-]+)#(\d+)\b/g
  for (const m of stripped.matchAll(crossRe)) {
    add(Number(m[2]))
    if (out.length >= MAX_REFS) return out
  }

  const bareRe = /(?<![/\w])#(\d+)\b/g
  for (const m of stripped.matchAll(bareRe)) {
    add(Number(m[1]))
    if (out.length >= MAX_REFS) return out
  }

  return out
}

function stripCodeRegions(s: string): string {
  // Fenced blocks first so inline-code regex doesn't chew their delimiters.
  const noFenced = s.replace(/```[\s\S]*?```/g, ' ')
  return noFenced.replace(/`[^`\n]*`/g, ' ')
}
