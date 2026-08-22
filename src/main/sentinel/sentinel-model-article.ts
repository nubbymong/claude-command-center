// sentinel-model-article.ts — read the LIVE Claude Code model configuration
// article (#385, review S1).
//
// Why this exists: `resources/model-registry.json` and the article snapshot
// ship in the same build, and the release gate refuses a cut while any article
// model is missing from the registry. So on a released build the "Anthropic
// added a model we don't offer" arm is empty BY CONSTRUCTION and could never
// fire from the snapshot alone. The owner asked for a check against what the
// article *currently* offers, which means actually looking at it.
//
// Fetch pattern mirrors sentinel-changelog.ts (dynamic https import, timeout,
// `catch -> null`): offline is not an error, it just means the caller falls
// back to the frozen snapshot and says so.
import { logInfo } from '../debug-logger'

export const MODEL_ARTICLE_URL =
  'https://support.claude.com/en/articles/11940350-claude-code-model-configuration'

const HOSTNAME = 'support.claude.com'
const PATH = '/en/articles/11940350-claude-code-model-configuration'

/**
 * A model id as the article spells it. Requires a DIGIT after the family so
 * `claude-code` (all over that page) is not mistaken for a model.
 * Matches claude-opus-5, claude-sonnet-4-6, claude-opus-4-5-20251101, ...
 */
const MODEL_ID_RE = /claude-(?:opus|sonnet|haiku|fable|mythos)-\d[0-9a-z-]*/gi

/**
 * A parse this thin can go wrong quietly if the page is restyled, so a result
 * carrying fewer ids than this is treated as "could not read" rather than as
 * evidence that Anthropic dropped everything.
 */
export const MIN_PLAUSIBLE_IDS = 3

/** Distinct model ids in article order. Trailing hyphens trimmed. */
export function parseArticleModelIds(html: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of html.matchAll(MODEL_ID_RE)) {
    const id = m[0].toLowerCase().replace(/-+$/, '')
    if (!seen.has(id)) { seen.add(id); out.push(id) }
  }
  return out
}

function get(hostname: string, path: string, timeoutMs: number, depth = 0): Promise<string | null> {
  if (depth > 3) return Promise.resolve(null)
  return (async () => {
    const https = await import('https')
    return await new Promise<string | null>((resolve, reject) => {
      const req = https.request({
        hostname, path, method: 'GET', timeout: timeoutMs,
        headers: { 'user-agent': 'ai-code-conductor-sentinel', accept: 'text/html' },
      }, (res) => {
        const status = res.statusCode ?? 0
        const location = res.headers.location
        if (status >= 300 && status < 400 && location) {
          res.resume()
          try {
            const next = new URL(location, `https://${hostname}${path}`)
            resolve(get(next.hostname, `${next.pathname}${next.search}`, timeoutMs, depth + 1))
          } catch { resolve(null) }
          return
        }
        if (status !== 200) { res.resume(); resolve(null); return }
        let d = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => { d += c })
        res.on('end', () => resolve(d))
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
      req.end()
    })
  })().catch(() => null)
}

/**
 * The model ids the article lists right now, or null when it could not be read
 * (offline, redirected away, restyled beyond recognition). Never throws.
 */
export async function fetchArticleModelIds(timeoutMs = 10000): Promise<string[] | null> {
  const html = await get(HOSTNAME, PATH, timeoutMs)
  if (!html) { logInfo('[sentinel] model article unavailable (offline?) — using the shipped snapshot'); return null }
  const ids = parseArticleModelIds(html)
  if (ids.length < MIN_PLAUSIBLE_IDS) {
    logInfo(`[sentinel] model article parsed only ${ids.length} id(s) — treating as unreadable, using the shipped snapshot`)
    return null
  }
  return ids
}
