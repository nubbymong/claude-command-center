// P3.9 (row 42): Codex's release notes as changelog text for Sentinel's
// analysis of a Codex update. The builder is pure; the fetch is tested with a
// faked `https` module (no network).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  codexReleaseNotesMarkdown, CODEX_RELEASE_BODY_MAX, CODEX_RELEASES_HOSTNAME, CODEX_RELEASES_PATH, CODEX_RELEASES_MAX_BYTES,
} from '../../src/main/sentinel/sentinel-codex-changelog'
import { sliceChangelog } from '../../src/main/sentinel/sentinel-changelog'

const release = (tag: string, body: string, over: Record<string, unknown> = {}) => ({ tag_name: tag, name: tag, body, draft: false, prerelease: false, ...over })

describe('codexReleaseNotesMarkdown', () => {
  it('keeps published stable releases, newest first, each as a version section', () => {
    const md = codexReleaseNotesMarkdown([
      release('rust-v0.155.1', '- fix A'),
      release('rust-v0.156.1', '- fix B'),
      release('rust-v0.156.0-alpha.3', '- alpha', { prerelease: true }),
      release('rust-v0.157.0', '- draft', { draft: true }),
      release('rust-v0.153.4', '- fix C'),
    ])!
    expect(md).toBe('## 0.156.1\n- fix B\n\n## 0.155.1\n- fix A\n\n## 0.153.4\n- fix C')
  })

  it('only a plain rust-v<major.minor.patch> tag counts; a release not marked published and stable does not', () => {
    const md = codexReleaseNotesMarkdown([
      release('v0.155.1', 'x'), release('rust-v0.155', 'x'), release('rust-v0.155.1-beta', 'x'), release('codex-0.155.1', 'x'),
      release('rust-v0.155.1 ', 'x'), { tag_name: 'rust-v0.155.2', body: 'no flags' }, release('rust-v0.155.3', 'x', { draft: 'false' }),
      release('rust-v0.155.4', 'ok'),
    ])
    expect(md).toBe('## 0.155.4\nok')
  })

  it("a heading inside a release's notes cannot open a section (a fake version) of its own", () => {
    const md = codexReleaseNotesMarkdown([release('rust-v0.155.1', '## Highlights\n- a\n# 9.9.9\n  ## 0.999.0\n### kept\n#### kept too')])!
    expect(md).toBe('## 0.155.1\n### Highlights\n- a\n### 9.9.9\n### 0.999.0\n### kept\n#### kept too')
    // The slice sees exactly one version, whose notes stay whole.
    const slice = sliceChangelog(md, '0.153.4', '0.155.1')
    expect(slice.match(/^## /gm)).toHaveLength(1)
    expect(slice).toContain('### 0.999.0')
  })

  it('control characters are dropped (line breaks and tabs kept), and each release is cut to its bound', () => {
    const esc = String.fromCharCode(27)
    const md = codexReleaseNotesMarkdown([release('rust-v0.155.1', `a${esc}[31mred\r\nb\tc${String.fromCharCode(0x9b)}d`), release('rust-v0.155.0', 'y'.repeat(CODEX_RELEASE_BODY_MAX + 500))])!
    expect(md).not.toContain(esc)
    expect(md).not.toContain(String.fromCharCode(0x9b))
    expect(md).toContain('a [31mred\nb\tc d')
    expect(md.split('## 0.155.0\n')[1].length).toBe(CODEX_RELEASE_BODY_MAX)
  })

  it('the same version twice counts once; a release without notes still marks its version', () => {
    expect(codexReleaseNotesMarkdown([release('rust-v0.155.1', 'first'), release('rust-v0.155.1', 'second'), { ...release('rust-v0.154.0', ''), body: null }])).toBe('## 0.155.1\nfirst\n\n## 0.154.0\n')
  })

  it('anything else is no notes: null, never an empty text', () => {
    for (const bad of [null, undefined, {}, 'x', 42, [], [null, 1, 'x'], [release('nope', 'x')], { length: 1, 0: release('rust-v0.155.1', 'x') }]) {
      expect(codexReleaseNotesMarkdown(bad), JSON.stringify(bad)).toBeNull()
    }
    // An inherited tag is not the release's own.
    expect(codexReleaseNotesMarkdown([Object.create(release('rust-v0.155.1', 'x'))])).toBeNull()
  })

  it('sliceChangelog takes the versions after the last one seen, up to the installed one', () => {
    const md = codexReleaseNotesMarkdown([release('rust-v0.156.1', 'c'), release('rust-v0.155.1', 'b'), release('rust-v0.153.4', 'a')])!
    expect(sliceChangelog(md, '0.153.4', '0.155.1')).toBe('## 0.155.1\nb\n\n')
  })
})

// ---------------------------------------------------------------------------

const httpsMock = vi.hoisted(() => ({ reply: null as null | { status: number; chunks: string[] }, requests: [] as Array<Record<string, unknown>>, error: null as null | Error }))
vi.mock('https', () => ({
  request: (opts: Record<string, unknown>, onRes: (res: EventEmitter & { statusCode: number; resume: () => void }) => void) => {
    httpsMock.requests.push(opts)
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (e?: Error) => void; destroyed: boolean }
    req.destroyed = false
    req.destroy = (e?: Error) => { if (req.destroyed) return; req.destroyed = true; if (e) req.emit('error', e); req.emit('close') }
    req.end = () => {
      queueMicrotask(() => {
        if (httpsMock.error) { req.emit('error', httpsMock.error); return }
        const r = httpsMock.reply!
        const res = Object.assign(new EventEmitter(), { statusCode: r.status, resume: () => {} })
        onRes(res)
        for (const c of r.chunks) { if (req.destroyed) return; res.emit('data', Buffer.from(c)) }
        if (!req.destroyed) { res.emit('end'); req.emit('close') }
      })
    }
    return req
  },
}))

afterEach(() => { httpsMock.reply = null; httpsMock.requests = []; httpsMock.error = null })

describe('fetchCodexReleaseNotes', () => {
  it("reads openai/codex's releases from GitHub's API, anonymously, and returns them as changelog text", async () => {
    const { fetchCodexReleaseNotes } = await import('../../src/main/sentinel/sentinel-codex-changelog')
    const body = JSON.stringify([release('rust-v0.155.1', '- b'), release('rust-v0.153.4', '- a')])
    httpsMock.reply = { status: 200, chunks: [body.slice(0, 10), body.slice(10)] }
    expect(await fetchCodexReleaseNotes()).toBe('## 0.155.1\n- b\n\n## 0.153.4\n- a')
    expect(httpsMock.requests[0]).toMatchObject({ hostname: CODEX_RELEASES_HOSTNAME, path: CODEX_RELEASES_PATH, method: 'GET' })
    expect(CODEX_RELEASES_HOSTNAME).toBe('api.github.com')
    expect(CODEX_RELEASES_PATH).toBe('/repos/openai/codex/releases?per_page=100')
    const headers = httpsMock.requests[0].headers as Record<string, string>
    expect(Object.keys(headers).map((k) => k.toLowerCase()).sort()).toEqual(['accept', 'user-agent', 'x-github-api-version'])
  })

  it('a non-200 answer, an unreadable reply, an oversized reply or no network is null', async () => {
    const { fetchCodexReleaseNotes } = await import('../../src/main/sentinel/sentinel-codex-changelog')
    httpsMock.reply = { status: 403, chunks: [JSON.stringify([release('rust-v0.155.1', 'x')])] }
    expect(await fetchCodexReleaseNotes()).toBeNull()
    httpsMock.reply = { status: 200, chunks: ['not json'] }
    expect(await fetchCodexReleaseNotes()).toBeNull()
    httpsMock.reply = { status: 200, chunks: ['[', ' '.repeat(CODEX_RELEASES_MAX_BYTES), JSON.stringify(release('rust-v0.155.1', 'x')), ']'] }
    expect(await fetchCodexReleaseNotes()).toBeNull()
    httpsMock.error = new Error('ENOTFOUND')
    expect(await fetchCodexReleaseNotes()).toBeNull()
  })
})
