// P3.10 (rows 43, 46, 47, 63): the Codex hook forwarder (scripts/ccc-codex-hook.js)
// trusts nothing it is given. The session is named by the environment Codex
// passes down and the hook file the app wrote for that launch: a small plain
// file, never a link, in a folder of the app's naming, whose session id must be
// the same; its port and token are checked for shape. It posts the event, as
// read, only to 127.0.0.1, with the session's token and the Codex marker, and
// is done once whatever happens. Nothing is started and nothing leaves the
// process: the request function is a fake.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, realpathSync } from 'fs'
import { join, basename, dirname } from 'path'
import { tmpdir } from 'os'
import { EventEmitter } from 'events'
import { Readable } from 'stream'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fwd = require('../../../scripts/ccc-codex-hook.js') as {
  readHookFile: (env: Record<string, string | undefined>) => { port: number; sid: string; token: string } | null
  forward: (cfg: { port: number; sid: string; token: string }, body: Buffer, done: () => void, request?: unknown) => void
  readBody: (stream: NodeJS.ReadableStream, onBody: (b: Buffer | null) => void) => void
  MAX_BODY_BYTES: number
  MAX_FILE_BYTES: number
}

const TOKEN = '0f8b6a2c-1d3e-4f50-9a61-7b2c3d4e5f60'
const TEST_PREFIX = 'p310-fwd-test-'
const made: string[] = []
function hookDir(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), TEST_PREFIX)))
  made.push(root)
  const dir = join(root, 'ccc-codex-hook-abc123')
  mkdirSync(dir)
  return dir
}
afterEach(() => {
  // TEST CLEANUP GUARD: only the folders this test made, by their own prefix, under the temp folder.
  for (const d of made.splice(0)) {
    if (!basename(d).startsWith(TEST_PREFIX) || dirname(d) !== realpathSync.native(tmpdir())) continue
    rmSync(d, { recursive: true, force: true })
  }
})

function goodFile(dir: string, over: Record<string, unknown> = {}): string {
  const file = join(dir, 'hook.json')
  writeFileSync(file, JSON.stringify({ v: 1, port: 51234, sid: 'sess-1', token: TOKEN, ...over }))
  return file
}

describe('readHookFile', () => {
  it('reads a good hook file for its own session', () => {
    const file = goodFile(hookDir())
    expect(fwd.readHookFile({ CCC_CODEX_HOOK_FILE: file, CLAUDE_MULTI_SESSION_ID: 'sess-1' })).toEqual({ port: 51234, sid: 'sess-1', token: TOKEN })
  })

  it('does nothing without its environment (Codex run outside the app)', () => {
    const file = goodFile(hookDir())
    expect(fwd.readHookFile({})).toBeNull()
    expect(fwd.readHookFile({ CCC_CODEX_HOOK_FILE: file })).toBeNull()
    expect(fwd.readHookFile({ CLAUDE_MULTI_SESSION_ID: 'sess-1' })).toBeNull()
  })

  it('refuses a file of another session, of another name, or outside a folder of the app\'s naming', () => {
    const dir = hookDir()
    const file = goodFile(dir)
    expect(fwd.readHookFile({ CCC_CODEX_HOOK_FILE: file, CLAUDE_MULTI_SESSION_ID: 'sess-2' })).toBeNull()
    const other = join(dir, 'other.json')
    writeFileSync(other, JSON.stringify({ v: 1, port: 51234, sid: 'sess-1', token: TOKEN }))
    expect(fwd.readHookFile({ CCC_CODEX_HOOK_FILE: other, CLAUDE_MULTI_SESSION_ID: 'sess-1' })).toBeNull()
    const plain = join(dirname(dir), 'hook.json')
    writeFileSync(plain, JSON.stringify({ v: 1, port: 51234, sid: 'sess-1', token: TOKEN }))
    expect(fwd.readHookFile({ CCC_CODEX_HOOK_FILE: plain, CLAUDE_MULTI_SESSION_ID: 'sess-1' })).toBeNull()
    expect(fwd.readHookFile({ CCC_CODEX_HOOK_FILE: 'hook.json', CLAUDE_MULTI_SESSION_ID: 'sess-1' })).toBeNull()
  })

  it('refuses a bad port, token, version or session id, and an oversized file', () => {
    const dir = hookDir()
    for (const over of [{ port: 0 }, { port: 70000 }, { port: '51234' }, { token: 'short' }, { token: 'a b c d e f g h i j k l' }, { v: 2 }]) {
      const file = goodFile(dir, over)
      expect(fwd.readHookFile({ CCC_CODEX_HOOK_FILE: file, CLAUDE_MULTI_SESSION_ID: 'sess-1' }), JSON.stringify(over)).toBeNull()
    }
    const bad = goodFile(dir, { sid: '../x' })
    expect(fwd.readHookFile({ CCC_CODEX_HOOK_FILE: bad, CLAUDE_MULTI_SESSION_ID: '../x' })).toBeNull()
    const big = join(dir, 'hook.json')
    writeFileSync(big, JSON.stringify({ v: 1, port: 51234, sid: 'sess-1', token: TOKEN, pad: 'x'.repeat(fwd.MAX_FILE_BYTES) }))
    expect(fwd.readHookFile({ CCC_CODEX_HOOK_FILE: big, CLAUDE_MULTI_SESSION_ID: 'sess-1' })).toBeNull()
  })

  it('never reads through a link', (ctx) => {
    const dir = hookDir()
    const target = join(dirname(dir), 'real.json')
    writeFileSync(target, JSON.stringify({ v: 1, port: 51234, sid: 'sess-1', token: TOKEN }))
    const link = join(dir, 'hook.json')
    // Skipped, visibly, where the host gives no right to make a file link (Windows without it).
    try { symlinkSync(target, link) } catch { ctx.skip(); return }
    expect(fwd.readHookFile({ CCC_CODEX_HOOK_FILE: link, CLAUDE_MULTI_SESSION_ID: 'sess-1' })).toBeNull()
  })
})

interface Captured { opts: Record<string, any>; body: Buffer | null; req: EventEmitter & { destroy: () => void; end: (b: Buffer) => void } }
function fakeRequest(behaviour: 'ok' | 'error' | 'timeout', captured: Captured[]) {
  return (opts: Record<string, any>, onRes: (res: EventEmitter & { resume: () => void }) => void) => {
    const req = new EventEmitter() as Captured['req']
    const entry: Captured = { opts, body: null, req }
    captured.push(entry)
    req.destroy = () => { /* noop */ }
    req.end = (b: Buffer) => {
      entry.body = b
      if (behaviour === 'ok') {
        const res = new EventEmitter() as EventEmitter & { resume: () => void }
        res.resume = () => { setImmediate(() => res.emit('end')) }
        onRes(res)
      } else if (behaviour === 'error') {
        setImmediate(() => req.emit('error', new Error('refused')))
      } else {
        setImmediate(() => req.emit('timeout'))
      }
    }
    return req
  }
}

describe('forward', () => {
  const cfg = { port: 51234, sid: 'sess-1', token: TOKEN }

  it('posts the body as read to 127.0.0.1 only, with the token and the Codex marker', async () => {
    const captured: Captured[] = []
    let done = 0
    const body = Buffer.from('{"hook_event_name":"SessionStart"}')
    await new Promise<void>((resolve) => fwd.forward(cfg, body, () => { done++; resolve() }, fakeRequest('ok', captured)))
    expect(captured.length).toBe(1)
    const o = captured[0].opts
    expect(o.host).toBe('127.0.0.1')
    expect(o.port).toBe(51234)
    expect(o.path).toBe('/hook/sess-1')
    expect(o.method).toBe('POST')
    expect(o.headers['x-ccc-hook-token']).toBe(TOKEN)
    expect(o.headers['x-ccc-hook-client']).toBe('codex')
    expect(o.headers['content-length']).toBe(body.length)
    expect(typeof o.timeout).toBe('number')
    expect(o.timeout).toBeLessThanOrEqual(2000)
    expect(captured[0].body?.equals(body)).toBe(true)
    expect(done).toBe(1)
  })

  it('is done exactly once on an error and on a timeout', async () => {
    for (const behaviour of ['error', 'timeout'] as const) {
      const captured: Captured[] = []
      let done = 0
      await new Promise<void>((resolve) => {
        fwd.forward(cfg, Buffer.from('{}'), () => { done++; setTimeout(resolve, 5) }, fakeRequest(behaviour, captured))
      })
      captured[0].req.emit('error', new Error('again'))
      await new Promise((r) => setTimeout(r, 5))
      expect(done, behaviour).toBe(1)
    }
  })

  it('is done once when the request cannot even be made', () => {
    let done = 0
    fwd.forward(cfg, Buffer.from('{}'), () => { done++ }, () => { throw new Error('no') })
    expect(done).toBe(1)
  })
})

describe('readBody', () => {
  it('reads to the end, and gives nothing for more than the cap', async () => {
    const small = await new Promise<Buffer | null>((r) => fwd.readBody(Readable.from([Buffer.from('ab'), Buffer.from('cd')]), r))
    expect(small?.toString()).toBe('abcd')
    const chunk = Buffer.alloc(1024 * 1024, 0x61)
    const big = await new Promise<Buffer | null>((r) => fwd.readBody(Readable.from([chunk, chunk, chunk, chunk, Buffer.from('x')]), r))
    expect(big).toBeNull()
  })
})
