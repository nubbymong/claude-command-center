// sentinel-changelog.ts — Fetch and slice the Claude Code CHANGELOG.md.
// Fetch pattern mirrors tk-pricing.ts (dynamic https import, same error handling).
import { compareSemver } from './sentinel-version'

export async function fetchChangelog(timeoutMs = 10000): Promise<string | null> {
  try {
    const https = await import('https')
    return await new Promise<string>((resolve, reject) => {
      const req = https.request({
        hostname: 'raw.githubusercontent.com',
        path: '/anthropics/claude-code/main/CHANGELOG.md',
        method: 'GET', timeout: timeoutMs,
      }, (res) => { let d = ''; res.on('data', (c: string) => { d += c }); res.on('end', () => resolve(d)) })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
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
