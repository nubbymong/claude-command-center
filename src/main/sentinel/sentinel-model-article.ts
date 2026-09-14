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
 * A model id as the article spells it, matched as a WHOLE token.
 *
 * Two rules, and both are load-bearing (ADR-009 MAJOR-1 on #404):
 *  - a DIGIT must follow the family, so `claude-code` (all over that page) is
 *    not mistaken for a model;
 *  - after the family only NUMERIC segments are allowed, and the lookahead
 *    rejects any continuation. The old pattern's trailing `[0-9a-z-]*` swallowed
 *    words, so the support-site slug `claude-fable-5-on-your-plan` came back as
 *    a model id. Truncating it to `claude-fable-5` would be just as wrong (a
 *    slug for an article about a FUTURE model would invent that model), so the
 *    lookahead drops the whole token instead of trimming it.
 *
 * Matches claude-opus-5, claude-sonnet-4-6, claude-opus-4-5-20251101, ...
 */
const MODEL_ID_RE = /claude-(?:opus|sonnet|haiku|fable|mythos)(?:-\d+)+(?![0-9a-z-])/gi

/** The heading that opens the article's "Supported models" section. */
const SUPPORTED_HEADING_RE = /<h([1-6])[^>]*>\s*supported\s+models\s*<\/h\1>/i

/**
 * A parse this thin can go wrong quietly if the page is restyled, so a result
 * carrying fewer ids than this is treated as "could not read" rather than as
 * evidence that Anthropic dropped everything.
 */
export const MIN_PLAUSIBLE_IDS = 3

/**
 * Visible TEXT of an HTML fragment: `<script>`/`<style>` bodies dropped whole,
 * then every tag replaced by a space.
 *
 * This is the primary MAJOR-1 defence. The phantom id was never in the article's
 * prose — it was in a sidebar link's `href` (and `title`), i.e. inside a tag.
 * Scanning text rather than markup means no attribute, URL slug, CSS class or
 * embedded JSON blob can contribute a "model" at all. Replacing a tag with a
 * SPACE (not '') also stops inline markup inside a code sample from splicing two
 * tokens together, while still healing an id that markup split
 * (`claude --model<b> </b>claude-haiku-4-5-20251001`).
 */
function visibleText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
}

/** Distinct ids in the order they appear in `fragment`. */
function idsIn(fragment: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of visibleText(fragment).matchAll(MODEL_ID_RE)) {
    const id = m[0].toLowerCase()
    if (!seen.has(id)) { seen.add(id); out.push(id) }
  }
  return out
}

/**
 * The article's "Supported models" section — from its heading to the next
 * heading of the same or higher level — or null when that heading is not there.
 */
export function supportedModelsSection(html: string): string | null {
  const head = SUPPORTED_HEADING_RE.exec(html)
  if (!head) return null
  const rest = html.slice(head.index + head[0].length)
  const next = new RegExp(`<h[1-${head[1]}]\\b`, 'i').exec(rest)
  return next ? rest.slice(0, next.index) : rest
}

/**
 * Distinct model ids in article order.
 *
 * Scoped to the "Supported models" section when the article still has that
 * heading, so a model named elsewhere on the page (a retired one in a "no longer
 * available" note, an example in another section) is not reported as newly
 * offered. When the heading is gone or the section reads as torn, this falls
 * back to the whole document — `visibleText` + the whole-token `MODEL_ID_RE`
 * make that fallback safe on its own, and a document that yields fewer than
 * MIN_PLAUSIBLE_IDS is treated as unreadable by the caller anyway.
 */
export function parseArticleModelIds(html: string): string[] {
  const section = supportedModelsSection(html)
  if (section) {
    const scoped = idsIn(section)
    if (scoped.length >= MIN_PLAUSIBLE_IDS) return scoped
  }
  return idsIn(html)
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
