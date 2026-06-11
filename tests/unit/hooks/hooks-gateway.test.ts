import { describe, it, expect, afterEach, vi } from 'vitest'
import { HooksGateway } from '../../../src/main/hooks/hooks-gateway'

describe('HooksGateway.start/stop', () => {
  let gw: HooksGateway | null = null
  afterEach(async () => {
    await gw?.stop()
    gw = null
  })

  it('binds on ephemeral port and reports listening', async () => {
    gw = new HooksGateway({ emit: vi.fn(), defaultPort: 0 })
    const status = await gw.start()
    expect(status.listening).toBe(true)
    expect(status.port).toBeGreaterThan(0)
  })

  it('stops cleanly', async () => {
    gw = new HooksGateway({ emit: vi.fn(), defaultPort: 0 })
    await gw.start()
    await gw.stop()
    expect(gw.status().listening).toBe(false)
    expect(gw.status().port).toBeNull()
  })

  it('rejects non-loopback requests with 403', async () => {
    gw = new HooksGateway({ emit: vi.fn(), defaultPort: 0 })
    await gw.start()
    gw.registerSession('sid-a')
    const r = await gw._handleRequestForTest({
      remoteAddress: '192.168.1.10',
      url: '/hook/sid-a',
      headers: {},
      body: '{}',
    })
    expect(r.status).toBe(403)
  })

  it('uses parsedBody when provided and does NOT re-parse the body string (perf dedup)', async () => {
    // The live HTTP path parses the body once and passes the object as
    // parsedBody so ingest never re-parses. Prove it: garbage body string but a
    // valid parsedBody => still 200 + emitted (body string is ignored).
    const emit = vi.fn()
    gw = new HooksGateway({ emit, defaultPort: 0 })
    await gw.start()
    const secret = gw.registerSession('sid-a')
    const r = await gw._handleRequestForTest({
      remoteAddress: '127.0.0.1',
      url: '/hook/sid-a',
      headers: { 'x-ccc-hook-token': secret },
      body: 'not-json-at-all',
      parsedBody: { event: 'PreToolUse', tool_name: 'Bash' },
    })
    expect(r.status).toBe(200)
    expect(emit).toHaveBeenCalled()
  })

  it('treats parsedBody=null as invalid JSON (400) without parsing body', async () => {
    gw = new HooksGateway({ emit: vi.fn(), defaultPort: 0 })
    await gw.start()
    const secret = gw.registerSession('sid-a')
    const r = await gw._handleRequestForTest({
      remoteAddress: '127.0.0.1',
      url: '/hook/sid-a',
      headers: { 'x-ccc-hook-token': secret },
      body: '{"event":"PreToolUse"}', // valid, but parsedBody=null wins
      parsedBody: null,
    })
    expect(r.status).toBe(400)
  })

  it('accepts IPv6 loopback :: and :: ffff:127.0.0.1', async () => {
    gw = new HooksGateway({ emit: vi.fn(), defaultPort: 0 })
    await gw.start()
    const secret = gw.registerSession('sid-a')
    for (const addr of ['::1', '::ffff:127.0.0.1']) {
      const r = await gw._handleRequestForTest({
        remoteAddress: addr,
        url: '/hook/sid-a',
        headers: { 'x-ccc-hook-token': secret },
        body: '{"event":"PreToolUse"}',
      })
      expect(r.status).toBe(200)
    }
  })

  it('stop() + start() clears per-session state', async () => {
    gw = new HooksGateway({ emit: vi.fn(), defaultPort: 0 })
    await gw.start()
    const secret = gw.registerSession('sid-a')
    await gw._handleRequestForTest({
      remoteAddress: '127.0.0.1',
      url: '/hook/sid-a',
      headers: { 'x-ccc-hook-token': secret },
      body: '{"event":"PreToolUse"}',
    })
    expect(gw.getBuffer('sid-a').length).toBe(1)
    await gw.stop()
    await gw.start()
    expect(gw.getBuffer('sid-a').length).toBe(0)
  })
})

describe('HooksGateway.request validation', () => {
  let gw: HooksGateway | null = null
  afterEach(async () => {
    await gw?.stop()
    gw = null
  })

  it('404s on unknown sid', async () => {
    gw = new HooksGateway({ emit: vi.fn(), defaultPort: 0 })
    await gw.start()
    const r = await gw._handleRequestForTest({
      remoteAddress: '127.0.0.1',
      url: '/hook/no-such-session',
      headers: { 'x-ccc-hook-token': 'anything' },
      body: '{"event":"PreToolUse"}',
    })
    expect(r.status).toBe(404)
  })

  it('404s on wrong token for known sid', async () => {
    gw = new HooksGateway({ emit: vi.fn(), defaultPort: 0 })
    await gw.start()
    gw.registerSession('sid-a')
    const r = await gw._handleRequestForTest({
      remoteAddress: '127.0.0.1',
      url: '/hook/sid-a',
      headers: { 'x-ccc-hook-token': 'wrong' },
      body: '{"event":"PreToolUse"}',
    })
    expect(r.status).toBe(404)
  })

  it('accepts valid sid+token, responds {}', async () => {
    gw = new HooksGateway({ emit: vi.fn(), defaultPort: 0 })
    await gw.start()
    const secret = gw.registerSession('sid-a')
    const r = await gw._handleRequestForTest({
      remoteAddress: '127.0.0.1',
      url: '/hook/sid-a',
      headers: { 'x-ccc-hook-token': secret },
      body: '{"event":"PreToolUse","tool_name":"Read"}',
    })
    expect(r.status).toBe(200)
    expect(r.body).toBe('{}')
  })

  it('400s on unparseable body', async () => {
    gw = new HooksGateway({ emit: vi.fn(), defaultPort: 0 })
    await gw.start()
    const secret = gw.registerSession('sid-a')
    const r = await gw._handleRequestForTest({
      remoteAddress: '127.0.0.1',
      url: '/hook/sid-a',
      headers: { 'x-ccc-hook-token': secret },
      body: 'not-json',
    })
    expect(r.status).toBe(400)
  })

  it('parses URL with stale query string', async () => {
    gw = new HooksGateway({ emit: vi.fn(), defaultPort: 0 })
    await gw.start()
    const secret = gw.registerSession('sid-a')
    const r = await gw._handleRequestForTest({
      remoteAddress: '127.0.0.1',
      url: '/hook/sid-a?t=legacy-query-secret',
      headers: { 'x-ccc-hook-token': secret },
      body: '{"event":"PreToolUse"}',
    })
    expect(r.status).toBe(200)
  })
})

describe('HooksGateway body-size cap (413)', () => {
  let gw: HooksGateway | null = null
  afterEach(async () => {
    await gw?.stop()
    gw = null
  })

  it('accepts a ~300 KiB payload (over the old 256 KiB cap, under the new 4 MiB cap)', async () => {
    // Regression: PostToolUse on a large file produces a body the old 256 KiB
    // cap rejected with 413, silently dropping the edit from CCC's feed.
    gw = new HooksGateway({ emit: vi.fn(), defaultPort: 0 })
    const status = await gw.start()
    const secret = gw.registerSession('sid-big')
    const body = JSON.stringify({ event: 'PostToolUse', tool_name: 'Edit', payload: { big: 'x'.repeat(300 * 1024) } })
    const res = await fetch(`http://127.0.0.1:${status.port}/hook/sid-big`, {
      method: 'POST',
      headers: { 'x-ccc-hook-token': secret, 'content-type': 'application/json' },
      body,
    })
    expect(res.status).toBe(200)
  })

  it('still rejects a payload over the 4 MiB cap with 413', async () => {
    gw = new HooksGateway({ emit: vi.fn(), defaultPort: 0 })
    const status = await gw.start()
    const secret = gw.registerSession('sid-huge')
    const body = JSON.stringify({ event: 'PostToolUse', tool_name: 'Edit', payload: { big: 'x'.repeat(4 * 1024 * 1024 + 1024) } })
    const res = await fetch(`http://127.0.0.1:${status.port}/hook/sid-huge`, {
      method: 'POST',
      headers: { 'x-ccc-hook-token': secret, 'content-type': 'application/json' },
      body,
    })
    expect(res.status).toBe(413)
  })
})

describe('HooksGateway.ingest', () => {
  let gw: HooksGateway | null = null
  let emitted: Array<{ channel: string; payload: unknown }> = []
  afterEach(async () => {
    await gw?.stop()
    gw = null
    emitted = []
  })

  function makeGw() {
    emitted = []
    return new HooksGateway({
      emit: (c, p) => emitted.push({ channel: c, payload: p }),
      defaultPort: 0,
    })
  }

  it('normalises event and emits hooks:event with sid in payload', async () => {
    gw = makeGw()
    await gw.start()
    const secret = gw.registerSession('sid-a')
    await gw._handleRequestForTest({
      remoteAddress: '127.0.0.1',
      url: '/hook/sid-a',
      headers: { 'x-ccc-hook-token': secret },
      body: JSON.stringify({
        event: 'PreToolUse',
        tool_name: 'Read',
        payload: { file_path: 'pkg.json' },
      }),
    })
    const ev = emitted.find((e) => e.channel === 'hooks:event')
    expect(ev).toBeDefined()
    const p = ev!.payload as { sessionId: string; event: string; toolName: string; summary?: string }
    expect(p.sessionId).toBe('sid-a')
    expect(p.event).toBe('PreToolUse')
    expect(p.toolName).toBe('Read')
    expect(p.summary).toBe('Read pkg.json')
  })

  it('redacts secrets before emit', async () => {
    gw = makeGw()
    await gw.start()
    const secret = gw.registerSession('sid-a')
    await gw._handleRequestForTest({
      remoteAddress: '127.0.0.1',
      url: '/hook/sid-a',
      headers: { 'x-ccc-hook-token': secret },
      body: JSON.stringify({
        event: 'PostToolUse',
        tool_name: 'Bash',
        payload: {
          cmd: 'curl -H "Authorization: sk-ant-abcdefghij0123456789abcdefghij0123456789"',
        },
      }),
    })
    const ev = emitted.find((e) => e.channel === 'hooks:event')!
    const cmd = (ev.payload as { payload: { cmd: string } }).payload.cmd
    expect(cmd).toContain('[REDACTED]')
    expect(cmd).not.toContain('sk-ant-abcdefghij')
  })

  it('caps ring buffer at 200 per session, emits dropped once', async () => {
    gw = makeGw()
    await gw.start()
    const secret = gw.registerSession('sid-a')
    for (let i = 0; i < 250; i++) {
      await gw._handleRequestForTest({
        remoteAddress: '127.0.0.1',
        url: '/hook/sid-a',
        headers: { 'x-ccc-hook-token': secret },
        body: JSON.stringify({ event: 'PreToolUse', tool_name: 'Read', payload: { i } }),
      })
    }
    expect(gw.getBuffer('sid-a').length).toBe(200)
    const dropped = emitted.filter((e) => e.channel === 'hooks:dropped')
    expect(dropped.length).toBe(1)
  })

  it('unknown event kind still emits (forward-compat)', async () => {
    gw = makeGw()
    await gw.start()
    const secret = gw.registerSession('sid-a')
    await gw._handleRequestForTest({
      remoteAddress: '127.0.0.1',
      url: '/hook/sid-a',
      headers: { 'x-ccc-hook-token': secret },
      body: JSON.stringify({ event: 'SomeFutureEvent', payload: {} }),
    })
    const ev = emitted.find((e) => e.channel === 'hooks:event')
    expect(ev).toBeDefined()
    expect((ev!.payload as { event: string }).event).toBe('SomeFutureEvent')
  })

  it('unregisterSession emits sessionEnded and clears buffer + latch', async () => {
    gw = makeGw()
    await gw.start()
    const secret = gw.registerSession('sid-a')
    await gw._handleRequestForTest({
      remoteAddress: '127.0.0.1',
      url: '/hook/sid-a',
      headers: { 'x-ccc-hook-token': secret },
      body: '{"event":"PreToolUse"}',
    })
    gw.unregisterSession('sid-a')
    expect(gw.getBuffer('sid-a').length).toBe(0)
    const ended = emitted.filter((e) => e.channel === 'hooks:sessionEnded')
    expect(ended.length).toBe(1)
    expect(ended[0].payload).toBe('sid-a')
  })

  it('rejects after unregister', async () => {
    gw = makeGw()
    await gw.start()
    const secret = gw.registerSession('sid-a')
    gw.unregisterSession('sid-a')
    const r = await gw._handleRequestForTest({
      remoteAddress: '127.0.0.1',
      url: '/hook/sid-a',
      headers: { 'x-ccc-hook-token': secret },
      body: '{"event":"PreToolUse"}',
    })
    expect(r.status).toBe(404)
  })
})
