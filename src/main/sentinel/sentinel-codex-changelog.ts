// Codex's release notes, for Sentinel's analysis of a Codex update (P3.9,
// row 42), as Claude Code's changelog is read for a Claude Code update
// (sentinel-changelog.ts). OpenAI publishes a Codex CLI release's notes on
// the openai/codex GitHub repository's releases, tagged `rust-v<semver>`;
// they are read from GitHub's public API, anonymously, only when Sentinel is
// on and the installed Codex version changed, or on a Re-run.
//
// The reply is untrusted text headed for an analysis prompt: it is capped as
// it arrives, read as a list of releases, and only published, non-prerelease
// releases with a plain `rust-v<major.minor.patch>` tag are kept, newest
// first, each as a `## <version>` section so sliceChangelog can take the
// versions between the last one seen and the one installed. A heading inside
// a release's own notes is demoted, so no note can open a section of its own
// (a fake version) or hide the next one; control characters other than line
// breaks and tabs are dropped, and each release's notes are cut to a bound.
// Offline, a non-200 answer, an oversized or unreadable reply: null, and the
// caller says the notes could not be read (never a finding).
import { compareSemver } from './sentinel-version'

export const CODEX_RELEASES_HOSTNAME = 'api.github.com'
export const CODEX_RELEASES_PATH = '/repos/openai/codex/releases?per_page=100'
/** The most reply bytes read; more is no answer. */
export const CODEX_RELEASES_MAX_BYTES = 8 * 1024 * 1024
/** The most characters kept of one release's notes. */
export const CODEX_RELEASE_BODY_MAX = 8000
/** The most releases looked at in a reply. */
export const CODEX_RELEASES_MAX_ENTRIES = 200

const TAG_RE = /^rust-v(\d{1,6}\.\d{1,6}\.\d{1,6})$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

const own = (o: object, k: string): unknown => (Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined)
const isRecord = (v: unknown): v is object => !!v && typeof v === 'object' && !Array.isArray(v)

/** One release's notes, made safe to sit inside the changelog text. */
function cleanBody(body: string): string {
  return body
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, ' ')
    // `# x` and `## x` would open a section of their own: demoted to `### x`.
    .replace(/^[ \t]*#{1,2}(?=[ \t]|$)/gm, '###')
    .slice(0, CODEX_RELEASE_BODY_MAX)
    .trim()
}

/** The releases as changelog text (`## <version>` sections, newest first),
 *  or null when the reply holds none this app reads. Exported for the test. */
export function codexReleaseNotesMarkdown(releases: unknown): string | null {
  if (!Array.isArray(releases)) return null
  const kept: Array<{ version: string; body: string }> = []
  const seen = new Set<string>()
  for (const r of releases.slice(0, CODEX_RELEASES_MAX_ENTRIES)) {
    if (!isRecord(r)) continue
    if (own(r, 'draft') !== false || own(r, 'prerelease') !== false) continue
    const tag = own(r, 'tag_name')
    const m = typeof tag === 'string' ? TAG_RE.exec(tag) : null
    if (!m || seen.has(m[1])) continue
    seen.add(m[1])
    const body = own(r, 'body')
    kept.push({ version: m[1], body: typeof body === 'string' ? cleanBody(body) : '' })
  }
  if (kept.length === 0) return null
  kept.sort((a, b) => compareSemver(b.version, a.version))
  return kept.map((k) => `## ${k.version}\n${k.body}`).join('\n\n')
}

/** Fetch the releases and return them as changelog text, or null. */
export async function fetchCodexReleaseNotes(timeoutMs = 10000): Promise<string | null> {
  try {
    const https = await import('https')
    const text = await new Promise<string>((resolve, reject) => {
      const req = https.request({
        hostname: CODEX_RELEASES_HOSTNAME,
        path: CODEX_RELEASES_PATH,
        method: 'GET',
        timeout: timeoutMs,
        headers: { 'User-Agent': 'ai-code-conductor-sentinel', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > CODEX_RELEASES_MAX_BYTES) { req.destroy(new Error('too large')); return }
          chunks.push(c)
        })
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        res.on('error', reject)
      })
      // An overall deadline as well as the socket's idle one.
      const deadline = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs)
      ;(deadline as unknown as { unref?: () => void }).unref?.()
      req.on('close', () => clearTimeout(deadline))
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(new Error('timeout')) })
      req.end()
    })
    return codexReleaseNotesMarkdown(JSON.parse(text))
  } catch {
    return null
  }
}
