// @vitest-environment node
//
// P3.4 (rows 45 and 14): each provider's public status page is read only
// while that provider is on (OD27 D5: a provider that is off makes no
// calls), Codex's from OpenAI's status page. An off provider's figures leave
// the payload, a switch on or off is acted on when the settings are saved,
// and a reply is read defensively: a 200 only (no redirect followed), a
// bounded body, known statuses only, the app's own labels and no remote
// text. Time is bounded: each read has an overall deadline, each provider's
// read settles on its own, a switch-off or stop aborts a read in flight.
// The answer to the renderer's pull goes to the app's own window only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const handlers = new Map<string, (e: unknown) => unknown>()
vi.mock('electron', () => ({
  BrowserWindow: class {},
  ipcMain: { handle: (ch: string, fn: (e: unknown) => unknown) => { handlers.set(ch, fn) } },
}))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const ANTHROPIC = 'https://status.claude.com/api/v2/components.json'
const OPENAI = 'https://status.openai.com/api/v2/components.json'

type Reply = { status: number; body?: string; headers?: Record<string, string>; delay?: number; drip?: number; hang?: boolean }
const requested: string[] = []
const reads: { url: string; destroyed: boolean; opts: any }[] = []
let replies: Record<string, Reply> = {}

// A stand-in for https.get that behaves like one: it honours the socket
// idle timeout it is given (req 'timeout'), stops delivering once destroyed,
// and can drip a body forever or never answer.
vi.mock('https', () => {
  const get = (url: string, opts: any, cb: (res: any) => void) => {
    requested.push(url)
    const rec = { url, destroyed: false, opts }
    reads.push(rec)
    const reply = replies[url] ?? { status: 503, body: '' }
    const reqH: Record<string, (arg?: unknown) => void> = {}
    const resH: Record<string, (arg?: unknown) => void> = {}
    const req: any = { on: (ev: string, fn: (arg?: unknown) => void) => { reqH[ev] = fn; return req }, destroy: () => { rec.destroyed = true } }
    const res: any = {
      statusCode: reply.status,
      headers: reply.headers ?? {},
      on: (ev: string, fn: (arg?: unknown) => void) => { resH[ev] = fn; return res },
      resume: () => {},
      destroy: () => { rec.destroyed = true },
    }
    if (reply.hang) {
      if (opts?.timeout) setTimeout(() => { if (!rec.destroyed) reqH.timeout?.() }, opts.timeout)
      return req
    }
    setTimeout(() => {
      if (rec.destroyed) return
      cb(res)
      if (reply.drip) {
        const t = setInterval(() => { if (rec.destroyed) { clearInterval(t); return } resH.data?.(Buffer.from(' ')) }, reply.drip)
        return
      }
      setTimeout(() => {
        if (rec.destroyed) return
        if (reply.body) resH.data?.(Buffer.from(reply.body))
        resH.end?.()
      }, reply.delay ?? 0)
    }, 0)
    return req
  }
  return { default: { get }, get }
})

const anthropicBody = (codeStatus = 'operational') => JSON.stringify({ components: [
  { id: 'yyzkbfz2thpt', name: 'Claude Code', status: codeStatus },
  { id: 'rwppv331jlwc', name: 'claude.ai', status: 'operational' },
  { id: 'k8w3r06qmzrp', name: 'Claude API (api.anthropic.com)', status: 'operational' },
] })
const openaiBody = (cli = 'operational', api = 'operational') => JSON.stringify({ components: [
  { id: '01KMKFAMWKNQ84Z1766MV08ZDE', name: 'CLI', status: cli },
  { id: '01KMP3KP5MGE23B80K1EK4S8PV', name: 'Codex API', status: api },
  { id: '01JMXBRMFE6N2NNT7DG6XZQ6PW', name: 'Chat Completions', status: 'major_outage' },
] })

const on: Record<string, boolean> = { claude: true, codex: false }
const sent: any[] = []
const mainFrame = { id: 'main' }
const webContents = { send: (_ch: string, p: unknown) => { sent.push(p) }, mainFrame }
const win = { isDestroyed: () => false, webContents }

type Mod = typeof import('../../../src/main/service-status')
let mod: Mod

async function start(): Promise<void> {
  mod = await import('../../../src/main/service-status')
  mod.startServiceStatusPoller(() => win as any, { providerOn: (id: string) => on[id] === true })
  await settle()
}
const settle = () => vi.advanceTimersByTimeAsync(20)
const last = () => mod.getLastServiceStatus() as any
const readsOf = (url: string) => reads.filter((r) => r.url === url)

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetModules()
  requested.length = 0
  reads.length = 0
  sent.length = 0
  handlers.clear()
  replies = { [ANTHROPIC]: { status: 200, body: anthropicBody() }, [OPENAI]: { status: 200, body: openaiBody() } }
  on.claude = true
  on.codex = false
})

afterEach(() => {
  mod?.stopServiceStatusPoller()
  vi.useRealTimers()
})

describe('provider status: one page per provider, read only while it is on', () => {
  it('Claude Code only (Codex off or not set up): Anthropic is read, OpenAI never is', async () => {
    await start()
    expect(requested).toEqual([ANTHROPIC])
    const p = last()
    expect(p.claudeCode).toEqual({ id: 'yyzkbfz2thpt', label: 'Claude Code', status: 'operational' })
    expect(p.codexCli).toBeNull()
    expect(p.codexApi).toBeNull()
    expect(p.claudeReadAt).toEqual(expect.any(String))
    expect(p.codexReadAt).toBeNull()
  })

  it('Codex only (Claude Code off): OpenAI is read for Codex, Anthropic never is', async () => {
    on.claude = false
    on.codex = true
    await start()
    expect(requested).toEqual([OPENAI])
    const p = last()
    expect(p.codexCli).toEqual({ id: '01KMKFAMWKNQ84Z1766MV08ZDE', label: 'Codex CLI', status: 'operational' })
    expect(p.codexApi).toEqual({ id: '01KMP3KP5MGE23B80K1EK4S8PV', label: 'Codex API', status: 'operational' })
    expect(p.claudeCode).toBeNull()
    expect(p.claudeAi).toBeNull()
    expect(p.api).toBeNull()
    expect(p.claudeReadAt).toBeNull()
    expect(p.codexReadAt).toEqual(expect.any(String))
    // Only the components tracked for Codex count: another OpenAI product's
    // outage does not tint the bar.
    expect(p.worst).toBe('operational')
    expect(sent.at(-1)).toEqual(p)
  })

  it('both on: both pages are read, and the worst status spans both', async () => {
    on.codex = true
    replies[OPENAI] = { status: 200, body: openaiBody('partial_outage') }
    await start()
    expect([...requested].sort()).toEqual([ANTHROPIC, OPENAI].sort())
    const p = last()
    expect(p.claudeCode.status).toBe('operational')
    expect(p.codexCli.status).toBe('partial_outage')
    expect(p.worst).toBe('partial_outage')
  })

  it('neither on: no request leaves at all', async () => {
    on.claude = false
    await start()
    expect(requested).toEqual([])
  })

  it('a settings save that turns Codex on reads its page at once; turning it off drops its figures without a request', async () => {
    await start()
    expect(requested).toEqual([ANTHROPIC])
    on.codex = true
    const r = mod.refreshServiceStatus()
    await settle()
    await r
    expect(requested).toContain(OPENAI)
    expect(last().codexCli.status).toBe('operational')

    requested.length = 0
    on.codex = false
    const r2 = mod.refreshServiceStatus()
    await settle()
    await r2
    expect(requested).not.toContain(OPENAI)
    const p = last()
    expect(p.codexCli).toBeNull()
    expect(p.codexReadAt).toBeNull()
    expect(sent.at(-1).codexCli).toBeNull()
  })

  it('a settings save that changes neither provider makes no request', async () => {
    await start()
    requested.length = 0
    const r = mod.refreshServiceStatus()
    await settle()
    await r
    expect(requested).toEqual([])
  })

  it('turning Claude Code off drops the Claude figures', async () => {
    on.codex = true
    await start()
    on.claude = false
    const r = mod.refreshServiceStatus()
    await settle()
    await r
    const p = last()
    expect(p.claudeCode).toBeNull()
    expect(p.claudeReadAt).toBeNull()
    expect(p.codexCli).not.toBeNull()
  })
})

describe('provider status: a reply is read defensively', () => {
  it('a status the app does not know, or a prototype key, is no status; the labels are the app\'s own and no remote text is sent', async () => {
    on.claude = false
    on.codex = true
    replies[OPENAI] = { status: 200, body: JSON.stringify({ components: [
      { id: '01KMKFAMWKNQ84Z1766MV08ZDE', name: 'x'.repeat(10_000), status: '<b>bad</b>' },
      { id: '01KMP3KP5MGE23B80K1EK4S8PV', name: 'Remote <i>name</i>', status: 'degraded_performance' },
    ] }) }
    await start()
    let p = last()
    expect(p.codexCli).toBeNull()
    expect(p.codexApi).toEqual({ id: '01KMP3KP5MGE23B80K1EK4S8PV', label: 'Codex API', status: 'degraded_performance' })
    expect(JSON.stringify(p)).not.toContain('Remote')
    expect(JSON.stringify(p)).not.toContain('xxxx')
    expect(p.codexReadAt).toEqual(expect.any(String))

    for (const status of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      mod.stopServiceStatusPoller()
      vi.resetModules()
      replies[OPENAI] = { status: 200, body: JSON.stringify({ components: [{ id: '01KMKFAMWKNQ84Z1766MV08ZDE', status }] }) }
      await start()
      p = last()
      expect(p.codexCli, status).toBeNull()
      expect(p.worst, status).toBe('operational')
    }
  })

  it('a null or non-object element in the list does not stop the tracked components being read', async () => {
    on.claude = false
    on.codex = true
    replies[OPENAI] = { status: 200, body: JSON.stringify({ components: [null, 7, 'x', [], { id: '01KMKFAMWKNQ84Z1766MV08ZDE', status: 'partial_outage' }] }) }
    await start()
    expect(last().codexCli).toEqual({ id: '01KMKFAMWKNQ84Z1766MV08ZDE', label: 'Codex CLI', status: 'partial_outage' })
  })

  it('a non-200 reply, a redirect (never followed), a body over the cap, or JSON of the wrong shape leaves no reading', async () => {
    on.claude = false
    on.codex = true
    for (const reply of [
      { status: 500, body: openaiBody() },
      { status: 301, body: openaiBody(), headers: { location: 'https://example.invalid/components.json' } },
      { status: 302, body: openaiBody(), headers: { location: 'https://example.invalid/components.json' } },
      { status: 200, body: openaiBody() + ' '.repeat(1024 * 1024) },
      { status: 200, body: '{"components": {"not": "a list"}}' },
      { status: 200, body: 'not json' },
    ] as Reply[]) {
      vi.resetModules()
      requested.length = 0
      replies[OPENAI] = reply
      await start()
      const p = last()
      expect(p?.codexReadAt ?? null, `${reply.status} ${String(reply.body).slice(0, 30)}`).toBeNull()
      expect(p?.codexCli ?? null).toBeNull()
      // Nothing is followed: the one request made is the status page's.
      expect(requested).toEqual([OPENAI])
      mod.stopServiceStatusPoller()
    }
  })
})

describe('provider status: time is bounded', () => {
  it('a reply that drips forever is cut at the overall deadline, and does not hold up the other provider', async () => {
    on.codex = true
    replies[OPENAI] = { status: 200, drip: 1000 } // under the idle timeout, never ends
    await start()
    // Claude's page landed on its own while OpenAI's still drips.
    expect(last().claudeCode.status).toBe('operational')
    expect(last().codexReadAt).toBeNull()
    expect(readsOf(OPENAI)[0].destroyed).toBe(false)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(readsOf(OPENAI)[0].destroyed).toBe(true)
    expect(last().codexReadAt).toBeNull()
    // The source is free again: a switch-off and on reads it afresh.
    replies[OPENAI] = { status: 200, body: openaiBody() }
    on.codex = false
    await mod.refreshServiceStatus()
    on.codex = true
    const r = mod.refreshServiceStatus()
    await settle()
    await r
    expect(readsOf(OPENAI)).toHaveLength(2)
    expect(last().codexCli.status).toBe('operational')
  })

  it('a reply that never comes is given up on (the idle timeout, then the deadline), and the socket is destroyed', async () => {
    on.claude = false
    on.codex = true
    replies[OPENAI] = { status: 200, hang: true }
    await start()
    expect(readsOf(OPENAI)[0].opts?.timeout).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(readsOf(OPENAI)[0].destroyed).toBe(true)
    expect(last()?.codexReadAt ?? null).toBeNull()
  })

  it('switching a provider off aborts its read in flight, and its late reply is ignored', async () => {
    on.codex = true
    replies[OPENAI] = { status: 200, body: openaiBody(), delay: 3000 }
    await start()
    expect(readsOf(OPENAI)[0].destroyed).toBe(false)
    on.codex = false
    await mod.refreshServiceStatus()
    expect(readsOf(OPENAI)[0].destroyed).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(last().codexCli).toBeNull()
    expect(last().codexReadAt).toBeNull()
  })

  it('a reply that lands after its provider went off (before the settings save is acted on) is not kept', async () => {
    on.codex = true
    replies[OPENAI] = { status: 200, body: openaiBody(), delay: 3000 }
    await start()
    on.codex = false
    await vi.advanceTimersByTimeAsync(5000)
    expect(last().codexCli).toBeNull()
    expect(last().codexReadAt).toBeNull()
  })

  it('stopping aborts every read in flight, and a late reply changes nothing', async () => {
    on.codex = true
    replies[OPENAI] = { status: 200, body: openaiBody(), delay: 3000 }
    replies[ANTHROPIC] = { status: 200, body: anthropicBody(), delay: 3000 }
    await start()
    const before = sent.length
    mod.stopServiceStatusPoller()
    expect(reads.every((r) => r.destroyed)).toBe(true)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 5000)
    expect(sent.length).toBe(before)
    expect(requested).toHaveLength(2) // no further poll after stop
  })

  it('a second start is ignored: one read per provider, one timer', async () => {
    on.codex = true
    await start()
    mod.startServiceStatusPoller(() => win as any, { providerOn: (id: string) => on[id] === true })
    await settle()
    expect(readsOf(ANTHROPIC)).toHaveLength(1)
    expect(readsOf(OPENAI)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(readsOf(ANTHROPIC)).toHaveLength(2)
    expect(readsOf(OPENAI)).toHaveLength(2)
  })
})

describe('provider status: the renderer pull answers the app window only', () => {
  it('its own window\'s top frame gets the payload; another sender or a subframe gets nothing', async () => {
    await start()
    mod.registerServiceStatusHandlers(() => win as any)
    const get = handlers.get('serviceStatus:get')!
    expect(get).toBeTypeOf('function')
    expect(get({ sender: webContents, senderFrame: mainFrame })).toEqual(last())
    expect(get({ sender: { send: () => {} }, senderFrame: mainFrame })).toBeNull()
    expect(get({ sender: webContents, senderFrame: { id: 'child' } })).toBeNull()
    expect(get({ sender: webContents, senderFrame: null })).toBeNull()
  })
})
