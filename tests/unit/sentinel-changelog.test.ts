import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { sliceChangelog, fetchChangelog, CHANGELOG_DEADLINE_MS } from '../../src/main/sentinel/sentinel-changelog'

const md = `# Changelog\n\n## 2.1.0\n- Hooks now require matcher-wrapped arrays\n\n## 2.0.14\n- Fix foo\n\n## 2.0.13\n- Old entry\n`

describe('sliceChangelog', () => {
  it('returns entries newer than lastSeen up to and including current', () => {
    const s = sliceChangelog(md, '2.0.13', '2.1.0')
    expect(s).toContain('## 2.1.0'); expect(s).toContain('## 2.0.14'); expect(s).not.toContain('Old entry')
  })
  it('unknown versions -> whole changelog head, capped', () => {
    expect(sliceChangelog(md, '9.9.9', '9.9.10').length).toBeGreaterThan(0)
  })
  it('versions with v prefix in headings are handled', () => {
    const md2 = '## v2.1.0\n- New\n\n## v2.0.13\n- Old\n'
    const s = sliceChangelog(md2, '2.0.13', '2.1.0')
    expect(s).toContain('v2.1.0'); expect(s).not.toContain('Old')
  })
})

// PR 4 (owner answers, the Sentinel chase): the changelog request against a
// faked `https` module (no network). `trickle`: a reply that sends a little
// every few seconds and never ends (each chunk resets a socket's idle timer).
const httpsMock = vi.hoisted(() => ({ status: 200, chunks: [] as string[], trickle: false, error: null as null | Error, requests: [] as Array<Record<string, unknown>>, timers: [] as Array<ReturnType<typeof setInterval>> }))
vi.mock('https', () => ({
  request: (opts: Record<string, unknown>, onRes: (res: EventEmitter & { statusCode: number; resume: () => void; setEncoding: (e: string) => void }) => void) => {
    httpsMock.requests.push(opts)
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (e?: Error) => void; destroyed: boolean }
    req.destroyed = false
    let res: (EventEmitter & { statusCode: number; resume: () => void; setEncoding: (e: string) => void }) | null = null
    req.destroy = (e?: Error) => {
      if (req.destroyed) return
      req.destroyed = true
      for (const t of httpsMock.timers) clearInterval(t)
      if (e) req.emit('error', e)
      if (res) res.emit('close')
      req.emit('close')
    }
    req.end = () => {
      queueMicrotask(() => {
        if (httpsMock.error) { req.emit('error', httpsMock.error); req.emit('close'); return }
        res = Object.assign(new EventEmitter(), { statusCode: httpsMock.status, resume: () => {}, setEncoding: () => {} })
        onRes(res)
        if (httpsMock.trickle) { httpsMock.timers.push(setInterval(() => { if (!req.destroyed) res!.emit('data', '- one more line\n') }, 5000)); return }
        for (const c of httpsMock.chunks) { if (req.destroyed) return; res.emit('data', c) }
        if (!req.destroyed) { res.emit('end'); res.emit('close'); req.emit('close') }
      })
    }
    return req
  },
}))
afterEach(() => {
  for (const t of httpsMock.timers) clearInterval(t)
  vi.useRealTimers()
  Object.assign(httpsMock, { status: 200, chunks: [], trickle: false, error: null, requests: [], timers: [] })
})

describe('fetchChangelog: only the changelog itself, within a deadline (PR 4, the Sentinel chase)', () => {
  it('200: the changelog text, from the one place it is read [host]', async () => {
    httpsMock.chunks = [md.slice(0, 20), md.slice(20)]
    expect(await fetchChangelog()).toBe(md)
    expect(httpsMock.requests[0]).toMatchObject({ hostname: 'raw.githubusercontent.com', path: '/anthropics/claude-code/main/CHANGELOG.md', method: 'GET' })
  })

  it('any other answer (a proxy refusing, a limit, a server error, a redirect) is "could not be read", never notes to analyse [host]', async () => {
    for (const status of [301, 403, 404, 407, 429, 500, 503]) {
      httpsMock.status = status
      httpsMock.chunks = ['<html><body>Access denied by proxy</body></html>']
      expect(await fetchChangelog(), String(status)).toBeNull()
    }
  })

  it('a reply that keeps trickling in is given up at the deadline, not waited on forever [host]', async () => {
    vi.useFakeTimers()
    httpsMock.trickle = true
    const p = fetchChangelog()
    await vi.advanceTimersByTimeAsync(CHANGELOG_DEADLINE_MS + 1)
    expect(await Promise.race([p, Promise.resolve('still waiting')])).toBeNull()
    expect(CHANGELOG_DEADLINE_MS).toBeLessThanOrEqual(30_000)
  })

  it('no network: null [host]', async () => {
    httpsMock.error = new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com')
    expect(await fetchChangelog()).toBeNull()
  })
})
