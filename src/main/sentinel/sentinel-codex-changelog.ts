// Codex's release notes, for Sentinel's analysis of a Codex update (P3.9,
// row 42), as Claude Code's changelog is read for a Claude Code update
// (sentinel-changelog.ts). OpenAI publishes a Codex CLI release's notes on
// the openai/codex GitHub repository's releases, tagged `rust-v<semver>`;
// they are read from GitHub's public API, anonymously, only when Sentinel is
// on and the installed Codex version changed, or on a Re-run.
//
// Round 1 (the VM): the releases list is about 30 MB for 100 releases (their
// asset lists), mostly prereleases, so the notes are read one version at a
// time (`/releases/tags/rust-v<version>`, a few hundred KB each), each reply
// capped, within a bound on the number of requests and an overall deadline:
// first the installed version's own notes (none, no analysis), then the
// stable versions between the last one seen and it, newest first. A version
// that does not exist answers 404 and ends that line of versions. A downgrade,
// the same version again (a Re-run) or a new major version reads the
// installed version's notes only, so a version newer than the one installed
// is never analysed under its id; a prerelease installed never takes in the
// stable release of the same number, which is newer than it.
//
// The reply is untrusted text headed for an analysis prompt: only a published
// release with exactly the requested tag is kept (a prerelease only when that
// is what is installed); each line of its notes is made prose-safe (controls,
// bidi and zero-width characters, line and paragraph separators and tag
// characters become spaces), its headings are demoted so no note can open a
// section (a fake version) of its own, and each version's notes are cut to its
// share of the total, with a line saying how much was left out. What was not
// read in full is said to the caller (`cut`), which says it in the panel.
import { compareVersions } from '../../shared/version-order'
import { stripSpoofableText } from '../../shared/safe-text'

export const CODEX_RELEASES_HOSTNAME = 'api.github.com'
/** The path of one release by its tag. */
export const codexReleaseTagPath = (tag: string) => `/repos/openai/codex/releases/tags/${encodeURIComponent(tag)}`
/** The most bytes read of one reply; more is no answer for that version. */
export const CODEX_RELEASE_MAX_BYTES = 2 * 1024 * 1024
/** The most requests one read makes (the installed version's included). */
export const CODEX_NOTES_MAX_REQUESTS = 16
/** No new request starts after this long. */
export const CODEX_NOTES_DEADLINE_MS = 45_000
/** The notes sent for analysis, all versions together (characters). */
export const CODEX_NOTES_MAX_CHARS = 20_000
/** No version's share of that is smaller than this. */
export const CODEX_NOTES_MIN_PER_VERSION = 1_500
/** The most patch releases looked for in one minor version. */
const MAX_PATCHES_PER_MINOR = 20

const VERSION_RE = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z][0-9A-Za-z.-]{0,31}))?$/

const own = (o: object, k: string): unknown => (Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined)
const isRecord = (v: unknown): v is object => !!v && typeof v === 'object' && !Array.isArray(v)

/** One release's notes, made safe to sit inside the notes text. */
export function cleanReleaseBody(body: string): string {
  return body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => stripSpoofableText(line, 100_000))
    .join('\n')
    // `# x` and `## x` would open a section of their own: demoted to `### x`.
    .replace(/^[ \t]*#{1,2}(?=[ \t]|$)/gm, '###')
    .trim()
}

/** What a tag request answered. */
export type CodexTagAnswer = { status: 'ok'; release: unknown } | { status: 'missing' } | { status: 'failed' }
export type CodexTagFetch = (tag: string) => Promise<CodexTagAnswer>

export interface CodexNotes {
  /** `## <version>` sections, newest first. */
  text: string
  versions: string[]
  /** Said when not every version's notes were read in full; else null. */
  cut: string | null
}

/** The notes of a release, when it is exactly the one asked for. */
function releaseBody(answer: CodexTagAnswer, tag: string, prerelease: boolean): string | null {
  if (answer.status !== 'ok' || !isRecord(answer.release)) return null
  const r = answer.release
  if (own(r, 'tag_name') !== tag || own(r, 'draft') !== false || own(r, 'prerelease') !== prerelease) return null
  const body = own(r, 'body')
  return typeof body === 'string' ? body : body === null ? '' : null
}

/** The notes as analysis text: each version's share of the total, newest first. */
export function assembleCodexNotes(entries: ReadonlyArray<{ version: string; body: string }>, maxChars: number = CODEX_NOTES_MAX_CHARS): { text: string; cutVersions: number } {
  const sorted = [...entries].sort((a, b) => compareVersions(b.version, a.version))
  const share = Math.max(CODEX_NOTES_MIN_PER_VERSION, Math.floor(maxChars / Math.max(1, sorted.length)))
  let cutVersions = 0
  const sections = sorted.map(({ version, body }) => {
    const clean = cleanReleaseBody(body)
    if (clean.length <= share) return `## ${version}\n${clean}`
    cutVersions++
    return `## ${version}\n${clean.slice(0, share)}\n[${clean.length - share} more characters of these notes were not included.]`
  })
  return { text: sections.join('\n\n'), cutVersions }
}

/** Reads the notes of the installed version and of the stable versions since
 *  `last`. Null when the installed version's own notes cannot be read. */
export async function fetchCodexReleaseNotes(
  last: string | null,
  installed: string,
  opts: { fetchTag?: CodexTagFetch; now?: () => number } = {},
): Promise<CodexNotes | null> {
  const iv = VERSION_RE.exec(installed)
  if (!iv) return null
  const fetchTag = opts.fetchTag ?? fetchCodexReleaseTag
  const now = opts.now ?? Date.now
  const started = now()
  let requests = 0
  let incomplete = false
  const ask = async (tag: string): Promise<CodexTagAnswer | null> => {
    if (requests >= CODEX_NOTES_MAX_REQUESTS || now() - started > CODEX_NOTES_DEADLINE_MS) { incomplete = true; return null }
    requests++
    try { return await fetchTag(tag) } catch { return { status: 'failed' } }
  }
  const installedPre = iv[4] !== undefined
  const first = await ask(`rust-v${installed}`)
  const ownNotes = first ? releaseBody(first, `rust-v${installed}`, installedPre) : null
  if (ownNotes === null) return null
  const entries: Array<{ version: string; body: string }> = [{ version: installed, body: ownNotes }]
  const lv = last !== null ? VERSION_RE.exec(last) : null
  if (lv && compareVersions(installed, last!) > 0 && lv[1] === iv[1]) {
    const major = Number(iv[1])
    const upperMinor = Number(iv[2])
    const upperPatch = Number(iv[3])
    const lastMinor = Number(lv[2])
    // A prerelease seen last comes before the stable release of its number.
    const lastStart = lv[4] !== undefined ? Number(lv[3]) : Number(lv[3]) + 1
    let stop = false
    for (let minor = upperMinor; minor >= lastMinor && !stop; minor--) {
      const start = minor === lastMinor ? lastStart : 0
      // In the installed version's minor the bound is known: below it (a
      // prerelease installed stops below its own number too).
      const knownEnd = minor === upperMinor ? upperPatch : null
      for (let patch = start; patch < (knownEnd ?? start + MAX_PATCHES_PER_MINOR); patch++) {
        const version = `${major}.${minor}.${patch}`
        const answer = await ask(`rust-v${version}`)
        if (answer === null) { stop = true; break }
        if (answer.status === 'failed') { incomplete = true; stop = true; break }
        if (answer.status === 'missing') { if (knownEnd === null) break; continue }
        const body = releaseBody(answer, `rust-v${version}`, false)
        if (body !== null) entries.push({ version, body })
      }
    }
  }
  const { text, cutVersions } = assembleCodexNotes(entries)
  const cut = incomplete
    ? "Not every Codex version's release notes since the last check could be read, so the analysis read the newest ones."
    : cutVersions > 0
      ? `Some of Codex's release notes were too long to send in full (${cutVersions === 1 ? 'one version' : `${cutVersions} versions`}), so the analysis read the start of them.`
      : null
  return { text, versions: entries.map((e) => e.version), cut }
}

/** One release by its tag from GitHub's public API: 200 is the release, 404
 *  is no such release, anything else (a limit, an oversized or unreadable
 *  reply, no network, the deadline) failed. */
export async function fetchCodexReleaseTag(tag: string, timeoutMs = 10_000): Promise<CodexTagAnswer> {
  if (!/^rust-v\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,31})?$/.test(tag)) return { status: 'failed' }
  try {
    const https = await import('https')
    return await new Promise<CodexTagAnswer>((resolve) => {
      let settled = false
      let responded = false
      const done = (a: CodexTagAnswer) => { if (!settled) { settled = true; resolve(a) } }
      const req = https.request({
        hostname: CODEX_RELEASES_HOSTNAME,
        path: codexReleaseTagPath(tag),
        method: 'GET',
        timeout: timeoutMs,
        headers: { 'User-Agent': 'ai-code-conductor-sentinel', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      }, (res) => {
        responded = true
        // A reply cut off before its end (destroyed, the deadline) failed.
        res.on('close', () => done({ status: 'failed' }))
        if (res.statusCode === 404) { res.resume(); done({ status: 'missing' }); return }
        if (res.statusCode !== 200) { res.resume(); done({ status: 'failed' }); return }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > CODEX_RELEASE_MAX_BYTES) { req.destroy(new Error('too large')); return }
          chunks.push(c)
        })
        res.on('end', () => {
          if (size > CODEX_RELEASE_MAX_BYTES) { done({ status: 'failed' }); return }
          try { done({ status: 'ok', release: JSON.parse(Buffer.concat(chunks).toString('utf8')) }) } catch { done({ status: 'failed' }) }
        })
        res.on('error', () => done({ status: 'failed' }))
      })
      // An overall deadline as well as the socket's idle one.
      const deadline = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs)
      ;(deadline as unknown as { unref?: () => void }).unref?.()
      req.on('close', () => { clearTimeout(deadline); if (!responded) done({ status: 'failed' }) })
      req.on('error', () => done({ status: 'failed' }))
      req.on('timeout', () => { req.destroy(new Error('timeout')) })
      req.end()
    })
  } catch {
    return { status: 'failed' }
  }
}
