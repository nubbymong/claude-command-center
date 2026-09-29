// P3.9 (row 42): Codex's release notes for Sentinel's analysis of a Codex
// update. Round 1: read version by version (the releases list is about 30 MB
// on GitHub, over any sensible cap), each reply bounded, within a request
// budget and a deadline; each version's notes cleaned and given its share of
// the total. The builders are pure; the reads use a fake tag fetch, and the
// one real request is tested against a faked `https` module (no network).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  cleanReleaseBody, assembleCodexNotes, fetchCodexReleaseNotes, fetchCodexReleaseTag, codexReleaseTagPath,
  CODEX_RELEASES_HOSTNAME, CODEX_RELEASE_MAX_BYTES, CODEX_NOTES_MAX_REQUESTS, CODEX_NOTES_MAX_CHARS, CODEX_NOTES_MIN_PER_VERSION, CODEX_NOTES_DEADLINE_MS,
} from '../../src/main/sentinel/sentinel-codex-changelog'
import type { CodexTagAnswer } from '../../src/main/sentinel/sentinel-codex-changelog'

const release = (tag: string, body: string, over: Record<string, unknown> = {}) => ({ tag_name: tag, name: tag, body, draft: false, prerelease: false, ...over })
const sections = (text: string) => text.split(/^## /m).slice(1).map((s) => s.split('\n')[0])

/** A fake GitHub: the releases it has, by tag; records every tag asked for. */
function fakeGitHub(releases: Array<ReturnType<typeof release>>, over: Partial<Record<string, CodexTagAnswer>> = {}) {
  const asked: string[] = []
  const byTag = new Map(releases.map((r) => [r.tag_name, r]))
  const fetchTag = async (tag: string): Promise<CodexTagAnswer> => {
    asked.push(tag)
    if (over[tag]) return over[tag]!
    const r = byTag.get(tag)
    return r ? { status: 'ok', release: r } : { status: 'missing' }
  }
  return { asked, fetchTag }
}

describe("cleanReleaseBody: a release's notes made safe to sit in the prompt", () => {
  it('headings are demoted, so no note opens a section (a fake version) of its own', () => {
    expect(cleanReleaseBody('## Highlights\n- a\n# 9.9.9\n  ## 0.999.0\n### kept\n#### kept too')).toBe('### Highlights\n- a\n### 9.9.9\n### 0.999.0\n### kept\n#### kept too')
  })

  it('no line break trick reaches a heading: CR, CRLF, line and paragraph separators, NEL, vertical tab, form feed', () => {
    const esc = (n: number) => String.fromCharCode(n)
    for (const brk of ['\r', '\r\n', esc(0x2028), esc(0x2029), esc(0x85), '\n' + esc(0x0b), '\n' + esc(0x0c)]) {
      const out = cleanReleaseBody(`x${brk}## 0.155.1${brk}INJ`)
      expect(out.split('\n').some((l) => l.startsWith('## ')), JSON.stringify(brk)).toBe(false)
    }
  })

  it('controls, bidi, zero-width, separator and tag characters become spaces; line breaks stay', () => {
    const esc = (n: number) => String.fromCodePoint(n)
    const odd = [0x1b, 0x07, 0x7f, 0x9b, 0x202e, 0x202c, 0x2066, 0x2069, 0x200b, 0x200d, 0x2060, 0x2028, 0x2029, 0xfeff, 0xe0041]
    const out = cleanReleaseBody('a' + odd.map(esc).join('b') + 'c\nnext line\ttab')
    for (const n of odd) expect(out.includes(esc(n)), n.toString(16)).toBe(false)
    expect(out.split('\n')).toHaveLength(2)
  })
})

describe('assembleCodexNotes: newest first, each version its share, cuts said', () => {
  it('orders newest first and keeps short notes whole', () => {
    const r = assembleCodexNotes([{ version: '0.154.0', body: 'b' }, { version: '0.155.1', body: 'c' }, { version: '0.155.0', body: 'a' }])
    expect(sections(r.text)).toEqual(['0.155.1', '0.155.0', '0.154.0'])
    expect(r.cutVersions).toBe(0)
  })

  it("long notes are cut to their share with a line that says how much, and the oldest version's are never crowded out", () => {
    const long = 'x'.repeat(CODEX_NOTES_MAX_CHARS)
    const r = assembleCodexNotes([{ version: '0.155.1', body: long }, { version: '0.155.0', body: long }, { version: '0.154.0', body: 'BREAKING-FLAG-REMOVED' }])
    expect(r.cutVersions).toBe(2)
    expect(r.text).toContain('BREAKING-FLAG-REMOVED')
    const share = Math.floor(CODEX_NOTES_MAX_CHARS / 3)
    expect(r.text).toContain(`[${CODEX_NOTES_MAX_CHARS - share} more characters of these notes were not included.]`)
    // Many versions still give each at least the floor.
    const many = assembleCodexNotes(Array.from({ length: 40 }, (_, i) => ({ version: `0.1${i}.0`, body: 'y'.repeat(5000) })))
    expect(many.text.split('\n\n')[0].length).toBeGreaterThanOrEqual(CODEX_NOTES_MIN_PER_VERSION)
  })
})

describe('fetchCodexReleaseNotes: version by version, the installed one first', () => {
  const GH = [
    release('rust-v0.155.1', 'N1551'), release('rust-v0.155.0', 'N1550'), release('rust-v0.154.0', 'N1540'),
    release('rust-v0.153.4', 'N1534'), release('rust-v0.156.0', 'N1560'), release('rust-v0.156.0-alpha.2', 'NALPHA', { prerelease: true }),
  ]

  it('an upgrade reads the installed version and the stable versions since the last one seen, never the list', async () => {
    const gh = fakeGitHub(GH)
    const n = (await fetchCodexReleaseNotes('0.153.4', '0.155.1', { fetchTag: gh.fetchTag }))!
    expect(n.versions).toEqual(['0.155.1', '0.155.0', '0.154.0'])
    expect(sections(n.text)).toEqual(['0.155.1', '0.155.0', '0.154.0'])
    expect(n.text).not.toContain('N1534')
    expect(n.text).not.toContain('N1560')
    expect(n.cut).toBeNull()
    expect(gh.asked[0]).toBe('rust-v0.155.1')
    // The last one seen is never read again; newest minors first.
    expect(gh.asked).not.toContain('rust-v0.153.4')
    expect(gh.asked.every((t) => /^rust-v\d+\.\d+\.\d+$/.test(t))).toBe(true)
  })

  it('the installed version with no notes to read gives no notes at all (null), whatever else exists', async () => {
    const gh = fakeGitHub(GH)
    expect(await fetchCodexReleaseNotes('0.153.4', '0.157.0', { fetchTag: gh.fetchTag })).toBeNull()
    expect(gh.asked).toEqual(['rust-v0.157.0'])
    expect(await fetchCodexReleaseNotes(null, 'not-a-version', { fetchTag: gh.fetchTag })).toBeNull()
  })

  it('a downgrade, the same version again, no last version or a new major reads the installed version only', async () => {
    for (const [last, installed] of [['0.155.1', '0.153.4'], ['0.155.1', '0.155.1'], [null, '0.155.1'], ['0.99.0', '0.155.1'.replace('0.', '1.')]] as const) {
      const gh = fakeGitHub([...GH, release('rust-v1.155.1', 'N1')])
      const n = await fetchCodexReleaseNotes(last, installed, { fetchTag: gh.fetchTag })
      expect(gh.asked, `${last} -> ${installed}`).toEqual([`rust-v${installed}`])
      expect(n!.versions).toEqual([installed])
    }
  })

  it('a prerelease installed reads its own (prerelease) notes and never the newer stable release of its number', async () => {
    const gh = fakeGitHub(GH)
    const n = (await fetchCodexReleaseNotes('0.155.1', '0.156.0-alpha.2', { fetchTag: gh.fetchTag }))!
    expect(n.versions).toEqual(['0.156.0-alpha.2'])
    expect(gh.asked).not.toContain('rust-v0.156.0')
    expect(n.text).toContain('NALPHA')
  })

  it('only a published release with exactly the tag asked for counts (a draft, a prerelease flag, another tag, an inherited field)', async () => {
    const bad = [
      { ...release('rust-v0.155.0', 'DRAFT'), draft: true },
      { ...release('rust-v0.155.0', 'PRE'), prerelease: true },
      { ...release('rust-v0.155.0', 'STR'), draft: 'false' },
      release('rust-v0.155.00', 'OTHER TAG'),
      Object.create(release('rust-v0.155.0', 'PROTO')),
    ]
    for (const b of bad) {
      const gh = fakeGitHub(GH, { 'rust-v0.155.0': { status: 'ok', release: b } })
      const n = (await fetchCodexReleaseNotes('0.154.9', '0.155.1', { fetchTag: gh.fetchTag }))!
      expect(n.versions, JSON.stringify(b)).toEqual(['0.155.1'])
    }
    // The installed version's own notes must be exactly it too.
    const gh = fakeGitHub(GH, { 'rust-v0.155.1': { status: 'ok', release: { ...release('rust-v0.155.1', 'x'), draft: true } } })
    expect(await fetchCodexReleaseNotes('0.155.0', '0.155.1', { fetchTag: gh.fetchTag })).toBeNull()
  })

  it('the request budget is bounded, and a read that could not cover the range says so', async () => {
    const all = Array.from({ length: 40 }, (_, i) => release(`rust-v0.${100 + i}.0`, `N${100 + i}`))
    const gh = fakeGitHub(all)
    const n = (await fetchCodexReleaseNotes('0.100.0', '0.139.0', { fetchTag: gh.fetchTag }))!
    expect(gh.asked.length).toBe(CODEX_NOTES_MAX_REQUESTS)
    expect(n.cut).toMatch(/Not every Codex version's release notes/)
    // Newest first: the installed one and the newest minors were read.
    expect(n.versions[0]).toBe('0.139.0')
    expect(n.versions).toContain('0.138.0')
    expect(n.versions).not.toContain('0.101.0')
  })

  it('a request that fails (a limit, no network) ends the read with what it has, said', async () => {
    const gh = fakeGitHub(GH, { 'rust-v0.155.0': { status: 'failed' } })
    const n = (await fetchCodexReleaseNotes('0.153.4', '0.155.1', { fetchTag: gh.fetchTag }))!
    expect(n.versions).toEqual(['0.155.1'])
    expect(n.cut).toMatch(/Not every/)
    expect(gh.asked).not.toContain('rust-v0.154.0')
  })

  it('no new request starts after the deadline', async () => {
    let t = 0
    const gh = fakeGitHub(GH)
    const slow = async (tag: string) => { t += CODEX_NOTES_DEADLINE_MS; return gh.fetchTag(tag) }
    const n = (await fetchCodexReleaseNotes('0.153.4', '0.155.1', { fetchTag: slow, now: () => t }))!
    expect(gh.asked).toEqual(['rust-v0.155.1', 'rust-v0.155.0'])
    expect(n.cut).toMatch(/Not every/)
  })

  it('a note that is too long is cut and said', async () => {
    const gh = fakeGitHub([release('rust-v0.155.1', 'z'.repeat(CODEX_NOTES_MAX_CHARS + 10))])
    const n = (await fetchCodexReleaseNotes('0.155.1', '0.155.1', { fetchTag: gh.fetchTag }))!
    expect(n.cut).toMatch(/too long to send in full \(one version\)/)
    expect(n.text.length).toBeLessThan(CODEX_NOTES_MAX_CHARS + 200)
  })
})

// ---------------------------------------------------------------------------

const httpsMock = vi.hoisted(() => ({ reply: null as null | { status: number; chunks: string[] }, requests: [] as Array<Record<string, unknown>>, error: null as null | Error, delivered: 0 }))
vi.mock('https', () => ({
  request: (opts: Record<string, unknown>, onRes: (res: EventEmitter & { statusCode: number; resume: () => void }) => void) => {
    httpsMock.requests.push(opts)
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (e?: Error) => void; destroyed: boolean }
    req.destroyed = false
    let res: (EventEmitter & { statusCode: number; resume: () => void }) | null = null
    req.destroy = (e?: Error) => {
      if (req.destroyed) return
      req.destroyed = true
      if (e) req.emit('error', e)
      if (res) res.emit('close')
      req.emit('close')
    }
    req.end = () => {
      queueMicrotask(() => {
        if (httpsMock.error) { req.emit('error', httpsMock.error); req.emit('close'); return }
        const r = httpsMock.reply!
        res = Object.assign(new EventEmitter(), { statusCode: r.status, resume: () => {} })
        onRes(res)
        for (const c of r.chunks) { if (req.destroyed) return; httpsMock.delivered++; res.emit('data', Buffer.from(c)) }
        if (!req.destroyed) { res.emit('end'); res.emit('close'); req.emit('close') }
      })
    }
    return req
  },
}))

afterEach(() => { httpsMock.reply = null; httpsMock.requests = []; httpsMock.error = null; httpsMock.delivered = 0 })

describe("fetchCodexReleaseTag: one release from GitHub's public API", () => {
  it('asks for exactly that tag, anonymously, and returns the release', async () => {
    httpsMock.reply = { status: 200, chunks: [JSON.stringify(release('rust-v0.155.1', 'x')).slice(0, 7), JSON.stringify(release('rust-v0.155.1', 'x')).slice(7)] }
    expect(await fetchCodexReleaseTag('rust-v0.155.1')).toEqual({ status: 'ok', release: release('rust-v0.155.1', 'x') })
    expect(httpsMock.requests[0]).toMatchObject({ hostname: CODEX_RELEASES_HOSTNAME, path: '/repos/openai/codex/releases/tags/rust-v0.155.1', method: 'GET' })
    expect(codexReleaseTagPath('rust-v0.155.1')).toBe('/repos/openai/codex/releases/tags/rust-v0.155.1')
    const headers = httpsMock.requests[0].headers as Record<string, string>
    expect(Object.keys(headers).map((k) => k.toLowerCase()).sort()).toEqual(['accept', 'user-agent', 'x-github-api-version'])
  })

  it('404 is no such release; any other answer, an oversized or unreadable reply or no network failed', async () => {
    httpsMock.reply = { status: 404, chunks: ['{"message":"Not Found"}'] }
    expect(await fetchCodexReleaseTag('rust-v0.155.9')).toEqual({ status: 'missing' })
    httpsMock.reply = { status: 403, chunks: ['{"message":"rate limit"}'] }
    expect(await fetchCodexReleaseTag('rust-v0.155.1')).toEqual({ status: 'failed' })
    httpsMock.reply = { status: 200, chunks: ['not json'] }
    expect(await fetchCodexReleaseTag('rust-v0.155.1')).toEqual({ status: 'failed' })
    // A reply the size of the whole releases list (about 30 MB) is refused at
    // the cap, and read no further: the request ends there.
    const big = ' '.repeat(CODEX_RELEASE_MAX_BYTES / 2)
    httpsMock.reply = { status: 200, chunks: ['[', ...Array.from({ length: 28 }, () => big), ']'] }
    httpsMock.delivered = 0
    expect(await fetchCodexReleaseTag('rust-v0.155.1')).toEqual({ status: 'failed' })
    expect(httpsMock.delivered).toBe(3)
    httpsMock.reply = null
    httpsMock.error = new Error('ENOTFOUND')
    expect(await fetchCodexReleaseTag('rust-v0.155.1')).toEqual({ status: 'failed' })
  })

  it('a tag that is not a plain rust-v version is never asked for', async () => {
    for (const bad of ['rust-v0.155.1/../../x', 'v0.155.1', 'rust-v0.155', 'rust-v0.155.1 ', 'rust-v0.155.1?per_page=100']) {
      expect(await fetchCodexReleaseTag(bad), bad).toEqual({ status: 'failed' })
    }
    expect(httpsMock.requests).toEqual([])
  })
})
