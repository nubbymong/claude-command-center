// @vitest-environment node
//
// P3.4 (rows 45 and 14): each provider's public status page is read only
// while that provider is on (OD27 D5: a provider that is off makes no
// calls), Codex's from OpenAI's status page. An off provider's figures leave
// the payload, a switch on or off is acted on when the settings are saved,
// and a reply is read defensively: a 200 only, a bounded body, known
// statuses only, the app's own labels.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {} }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const ANTHROPIC = 'https://status.claude.com/api/v2/components.json'
const OPENAI = 'https://status.openai.com/api/v2/components.json'

const requested: string[] = []
let replies: Record<string, { status: number; body: string }> = {}

vi.mock('https', () => {
  const get = (url: string, _opts: unknown, cb: (res: any) => void) => {
    requested.push(url)
    const reply = replies[url] ?? { status: 503, body: '' }
    const handlers: Record<string, (arg?: unknown) => void> = {}
    const res: any = {
      statusCode: reply.status,
      on: (ev: string, fn: (arg?: unknown) => void) => { handlers[ev] = fn; return res },
      resume: () => {},
      destroy: () => {},
    }
    const req: any = { on: () => req, destroy: () => {} }
    queueMicrotask(() => {
      cb(res)
      queueMicrotask(() => {
        if (reply.body) handlers.data?.(Buffer.from(reply.body))
        handlers.end?.()
      })
    })
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
const win = { isDestroyed: () => false, webContents: { send: (_ch: string, p: unknown) => { sent.push(p) } } }

type Mod = typeof import('../../../src/main/service-status')
let mod: Mod

async function start(): Promise<void> {
  mod = await import('../../../src/main/service-status')
  ;(mod.startServiceStatusPoller as any)(() => win, { providerOn: (id: string) => on[id] === true })
  await settle()
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  vi.resetModules()
  requested.length = 0
  sent.length = 0
  replies = { [ANTHROPIC]: { status: 200, body: anthropicBody() }, [OPENAI]: { status: 200, body: openaiBody() } }
  on.claude = true
  on.codex = false
})

afterEach(() => {
  mod?.stopServiceStatusPoller()
})

describe('provider status: one page per provider, read only while it is on', () => {
  it('Claude Code only (Codex off or not set up): Anthropic is read, OpenAI never is', async () => {
    await start()
    expect(requested).toEqual([ANTHROPIC])
    const p = mod.getLastServiceStatus() as any
    expect(p.claudeCode).toMatchObject({ label: 'Claude Code', status: 'operational' })
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
    const p = mod.getLastServiceStatus() as any
    expect(p.codexCli).toMatchObject({ id: '01KMKFAMWKNQ84Z1766MV08ZDE', label: 'Codex CLI', status: 'operational' })
    expect(p.codexApi).toMatchObject({ id: '01KMP3KP5MGE23B80K1EK4S8PV', label: 'Codex API', status: 'operational' })
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
    const p = mod.getLastServiceStatus() as any
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
    await (mod as any).refreshServiceStatus()
    await settle()
    expect(requested).toContain(OPENAI)
    expect((mod.getLastServiceStatus() as any).codexCli.status).toBe('operational')

    requested.length = 0
    on.codex = false
    await (mod as any).refreshServiceStatus()
    await settle()
    expect(requested).not.toContain(OPENAI)
    const p = mod.getLastServiceStatus() as any
    expect(p.codexCli).toBeNull()
    expect(p.codexReadAt).toBeNull()
    expect(sent.at(-1).codexCli).toBeNull()
  })

  it('a settings save that changes neither provider makes no request', async () => {
    await start()
    requested.length = 0
    await (mod as any).refreshServiceStatus()
    await settle()
    expect(requested).toEqual([])
  })

  it('turning Claude Code off drops the Claude figures', async () => {
    on.codex = true
    await start()
    on.claude = false
    await (mod as any).refreshServiceStatus()
    await settle()
    const p = mod.getLastServiceStatus() as any
    expect(p.claudeCode).toBeNull()
    expect(p.claudeReadAt).toBeNull()
    expect(p.codexCli).not.toBeNull()
  })
})

describe('provider status: a reply is read defensively', () => {
  it('a status the app does not know is no status (unknown), and the labels are the app\'s own', async () => {
    on.claude = false
    on.codex = true
    replies[OPENAI] = { status: 200, body: JSON.stringify({ components: [
      { id: '01KMKFAMWKNQ84Z1766MV08ZDE', name: 'x'.repeat(10_000), status: '<b>bad</b>' },
      { id: '01KMP3KP5MGE23B80K1EK4S8PV', name: 42, status: 'degraded_performance' },
    ] }) }
    await start()
    const p = mod.getLastServiceStatus() as any
    expect(p.codexCli).toBeNull()
    expect(p.codexApi).toMatchObject({ label: 'Codex API', status: 'degraded_performance' })
    expect(p.codexApi.name.length).toBeLessThanOrEqual(100)
    expect(p.codexReadAt).toEqual(expect.any(String))
  })

  it('a non-200 reply, a body over the cap, or JSON of the wrong shape leaves no reading', async () => {
    on.claude = false
    on.codex = true
    for (const reply of [
      { status: 500, body: openaiBody() },
      { status: 200, body: openaiBody() + ' '.repeat(1024 * 1024) },
      { status: 200, body: '{"components": {"not": "a list"}}' },
      { status: 200, body: 'not json' },
    ]) {
      vi.resetModules()
      replies[OPENAI] = reply
      await start()
      const p = mod.getLastServiceStatus() as any
      expect(p?.codexReadAt ?? null, JSON.stringify(reply).slice(0, 60)).toBeNull()
      expect(p?.codexCli ?? null).toBeNull()
      mod.stopServiceStatusPoller()
    }
  })
})
