// sentinel-changelog.ts — Fetch and slice the Claude Code CHANGELOG.md.
// Fetch pattern mirrors tk-pricing.ts (dynamic https import, same error handling).
import { compareSemver } from './sentinel-version'

/** PR 4 (owner answers, the Sentinel chase): the longest the changelog read
 *  takes in all, as well as the socket's idle limit (a reply that keeps
 *  trickling in never trips that one), so unread notes are said promptly. */
export const CHANGELOG_DEADLINE_MS = 20_000

export async function fetchChangelog(timeoutMs = 10000): Promise<string | null> {
  try {
    const https = await import('https')
    return await new Promise<string | null>((resolve) => {
      let settled = false
      const done = (v: string | null) => { if (!settled) { settled = true; clearTimeout(deadline); resolve(v) } }
      const req = https.request({
        hostname: 'raw.githubusercontent.com',
        path: '/anthropics/claude-code/main/CHANGELOG.md',
        method: 'GET', timeout: timeoutMs,
      }, (res) => {
        // PR 4: only the changelog itself is the changelog. Any other answer
        // (a proxy refusing, a limit, a server error) could not be read; it is
        // never analysed as if it were the notes.
        if (res.statusCode !== 200) { res.resume(); done(null); return }
        let d = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => { d += c })
        res.on('end', () => done(d))
        res.on('error', () => done(null))
        res.on('close', () => done(null))          // cut off before its end
      })
      const deadline = setTimeout(() => { req.destroy(new Error('timeout')); done(null) }, CHANGELOG_DEADLINE_MS)
      ;(deadline as unknown as { unref?: () => void }).unref?.()
      req.on('error', () => done(null))
      req.on('timeout', () => { req.destroy(new Error('timeout')) })
      req.end()
    })
  } catch { return null }                       // offline -> caller raises "analysis unavailable" (spec §7)
}

const MAX_SLICE = 20000                          // prompt-size cap

/** Entries (lastSeen, current]. Heading format: `## <semver>` or `## v<semver>`. Unknown bounds -> head of file, capped. */
export function sliceChangelog(md: string, lastSeen: string, current: string): string {
  const sections = md.split(/^## /m).slice(1).map((s) => '## ' + s)
  const inRange = sections.filter((s) => {
    const v = /^## v?(\d+\.\d+\.\d+\S*)/.exec(s)?.[1]
    if (!v) return false
    return compareSemver(v, lastSeen) > 0 && compareSemver(v, current) <= 0
  })
  const out = inRange.length ? inRange.join('\n') : sections.slice(0, 5).join('\n')
  return out.slice(0, MAX_SLICE)
}
