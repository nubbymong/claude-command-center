// HOST QUARANTINE: plants junctions, symbolic links and hard links. [CI] [VM] only -- never run on the owner's machine.
// P3.10 (rows 43, 46, 47, 63): the Codex hook forwarder (scripts/ccc-codex-hook.js)
// trusts nothing it is given. The session is named by the environment Codex
// passes down and the hook file the app wrote for that launch, laid out as the
// app makes it (`<app data folder>/codex-hooks/ccc-codex-hook-*/hook.json`,
// P3.10 round 1): its real path must be that very path below the app data
// folder's real path (no link or junction at any level the app made), and it
// must be a small plain file with one name, still the file looked at when
// opened; its session id must be the same, its port and token the right
// shape. It posts the event, as read, only to 127.0.0.1, with the session's
// token and the Codex marker, never through a proxy the environment names,
// and is done once whatever happens. Nothing is started: the request function
// is a fake, or (the proxy case) a real loopback request to listeners in this
// process.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, realpathSync, linkSync, unlinkSync, rmdirSync, lstatSync } from 'fs'
import { join, basename, dirname } from 'path'
import { tmpdir } from 'os'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import type * as http from 'http'
import type { AddressInfo } from 'net'
import { CODEX_HOOK_ROOT_NAME } from '../../../src/main/providers/codex/hooks'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fwd = require('../../../scripts/ccc-codex-hook.js') as {
  readHookFile: (env: Record<string, string | undefined>) => { port: number; sid: string; token: string } | null
  forward: (cfg: { port: number; sid: string; token: string }, body: Buffer, done: () => void, request?: unknown) => void
  readBody: (stream: NodeJS.ReadableStream, onBody: (b: Buffer | null) => void) => void
  requestOptions: (cfg: { port: number; sid: string; token: string }, body: Buffer) => Record<string, any>
  MAX_BODY_BYTES: number
  MAX_FILE_BYTES: number
  ROOT_NAME: string
}
// The CommonJS module object itself (the forwarder's own require('http')), whose
// shared agent the proxy case replaces for a moment.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const httpMod = require('http') as typeof http

const TOKEN = '0f8b6a2c-1d3e-4f50-9a61-7b2c3d4e5f60'
const TEST_PREFIX = 'p310-fwd-test-'
const made: string[] = []
const links: string[] = []
/** A fresh app data folder of this test's own. */
function appDir(): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), TEST_PREFIX)))
  made.push(d)
  return d
}
/** A hook folder laid out as the app makes it, in a fresh app data folder. */
function hookDir(app = appDir()): string {
  const dir = join(app, 'codex-hooks', 'ccc-codex-hook-abc123')
  mkdirSync(dir, { recursive: true })
  return dir
}
/** A folder link: a junction on Windows (no special right needed), a symlink elsewhere. */
function folderLink(target: string, at: string): void {
  symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir')
  links.push(at)
}
afterEach(() => {
  // Links first, removed as links (never followed), then only the folders this
  // test made, by their own prefix, directly under the temp folder.
  for (const l of links.splice(0)) {
    try { if (lstatSync(l).isSymbolicLink()) { try { unlinkSync(l) } catch { rmdirSync(l) } } } catch { /* gone */ }
  }
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
  it('reads a good hook file for its own session, laid out as the app makes it', () => {
    const file = goodFile(hookDir())
    expect(fwd.readHookFile({ CCC_CODEX_HOOK_FILE: file, CLAUDE_MULTI_SESSION_ID: 'sess-1' })).toEqual({ port: 51234, sid: 'sess-1', token: TOKEN })
    // The layout's folder name is the app's own (hooks.ts).
    expect(fwd.ROOT_NAME).toBe(CODEX_HOOK_ROOT_NAME)
  })

  it('does nothing without its environment (Codex run outside the app)', () => {
    const file = goodFile(hookDir())
    expect(fwd.readHookFile({})).toBeNull()
    expect(fwd.readHookFile({ CCC_CODEX_HOOK_FILE: file })).toBeNull()
    expect(fwd.readHookFile({ CLAUDE_MULTI_SESSION_ID: 'sess-1' })).toBeNull()
  })

  it('refuses a file of another session, of another name, or outside the app\'s layout', () => {
    const dir = hookDir()
    const file = goodFile(dir)
    expect(fwd.readHookFile({ CCC_CODEX_HOOK_FILE: file, CLAUDE_MULTI_SESSION_ID: 'sess-2' })).toBeNull()
    const other = join(dir, 'other.json')
    writeFileSync(other, JSON.stringify({ v: 1, port: 51234, sid: 'sess-1', token: TOKEN }))
    expect(fwd.readHookFile({ CCC_CODEX_HOOK_FILE: other, CLAUDE_MULTI_SESSION_ID: 'sess-1' })).toBeNull()
    // Directly in codex-hooks (no hook folder), and a hook folder not in codex-hooks.
    const plain = join(dirname(dir), 'hook.json')
    writeFileSync(plain, JSON.stringify({ v: 1, port: 51234, sid: 'sess-1', token: TOKEN }))
    expect(fwd.readHookFile({ CCC_CODEX_HOOK_FILE: plain, CLAUDE_MULTI_SESSION_ID: 'sess-1' })).toBeNull()
    const stray = join(appDir(), 'elsewhere', 'ccc-codex-hook-abc123')
    mkdirSync(stray, { recursive: true })
    expect(fwd.readHookFile({ CCC_CODEX_HOOK_FILE: goodFile(stray), CLAUDE_MULTI_SESSION_ID: 'sess-1' })).toBeNull()
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

  it('refuses a hook folder, or the codex-hooks folder, that is a link or junction to a folder elsewhere (round 1)', () => {
    // Elsewhere: a good file in the same layout.
    const elsewhere = hookDir()
    goodFile(elsewhere)
    // The hook folder itself is a link.
    const app = appDir()
    mkdirSync(join(app, 'codex-hooks'))
    const viaHookDir = join(app, 'codex-hooks', 'ccc-codex-hook-link01')
    folderLink(elsewhere, viaHookDir)
    expect(fwd.readHookFile({ CCC_CODEX_HOOK_FILE: join(viaHookDir, 'hook.json'), CLAUDE_MULTI_SESSION_ID: 'sess-1' })).toBeNull()
    // The codex-hooks folder is a link.
    const app2 = appDir()
    folderLink(dirname(elsewhere), join(app2, 'codex-hooks'))
    expect(fwd.readHookFile({ CCC_CODEX_HOOK_FILE: join(app2, 'codex-hooks', basename(elsewhere), 'hook.json'), CLAUDE_MULTI_SESSION_ID: 'sess-1' })).toBeNull()
    // The same file by its own path is read.
    expect(fwd.readHookFile({ CCC_CODEX_HOOK_FILE: join(elsewhere, 'hook.json'), CLAUDE_MULTI_SESSION_ID: 'sess-1' })).not.toBeNull()
  })

  it('an app data folder reached through a link is the app\'s own choice: read', () => {
    const real = appDir()
    const dir = hookDir(real)
    goodFile(dir)
    const viaLink = join(appDir(), 'app-link')
    folderLink(real, viaLink)
    expect(fwd.readHookFile({ CCC_CODEX_HOOK_FILE: join(viaLink, 'codex-hooks', basename(dir), 'hook.json'), CLAUDE_MULTI_SESSION_ID: 'sess-1' })).not.toBeNull()
  })

  it('refuses a hook file with a second name (a hard link) (round 1)', () => {
    const dir = hookDir()
    const target = join(dirname(dirname(dir)), 'target.json')
    writeFileSync(target, JSON.stringify({ v: 1, port: 51234, sid: 'sess-1', token: TOKEN }))
    linkSync(target, join(dir, 'hook.json'))
    expect(fwd.readHookFile({ CCC_CODEX_HOOK_FILE: join(dir, 'hook.json'), CLAUDE_MULTI_SESSION_ID: 'sess-1' })).toBeNull()
  })

  it('a file put in the hook file\'s place between its look and its open is not read (round 1: the opened file is the one looked at)', () => {
    const dir = hookDir()
    const file = goodFile(dir)
    const other = join(dir, 'swap.json')
    writeFileSync(other, JSON.stringify({ v: 1, port: 40404, sid: 'sess-1', token: TOKEN }))
    // The forwarder's own fs (CommonJS): its open is where the swap lands.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fsCjs = require('fs') as typeof import('fs')
    const realOpen = fsCjs.openSync
    const spy = vi.spyOn(fsCjs, 'openSync').mockImplementation(((p: string, ...rest: unknown[]) => {
      if (p === file) fsCjs.renameSync(other, file)
      return (realOpen as (...a: unknown[]) => number)(p, ...rest)
    }) as typeof fsCjs.openSync)
    try {
      expect(fwd.readHookFile({ CCC_CODEX_HOOK_FILE: file, CLAUDE_MULTI_SESSION_ID: 'sess-1' })).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  it('round 2: compares file identities as bigints (an NTFS id past 2^53 loses its low bits as a number)', () => {
    const dir = hookDir()
    const file = goodFile(dir)
    // The file looked at differs from the one opened only in its id's lowest
    // bit: equal as numbers once past 2^53, different as bigints.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fsCjs = require('fs') as typeof import('fs')
    const realLstat = fsCjs.lstatSync
    const spy = vi.spyOn(fsCjs, 'lstatSync').mockImplementation(((p: string, o?: { bigint?: boolean }) => {
      const real = (realLstat as (...a: unknown[]) => unknown)(p, o) as Record<string, unknown>
      if (p !== file || !o || o.bigint !== true) return real
      return new Proxy(real, { get: (target, k) => (k === 'ino' ? (target.ino as bigint) ^ 1n : typeof target[k as string] === 'function' ? (target[k as string] as () => unknown).bind(target) : target[k as string]) })
    }) as unknown as typeof fsCjs.lstatSync)
    try {
      expect(fwd.readHookFile({ CCC_CODEX_HOOK_FILE: file, CLAUDE_MULTI_SESSION_ID: 'sess-1' })).toBeNull()
      // The same file, looked at and opened, is read (bigint ids equal).
      spy.mockRestore()
      expect(fwd.readHookFile({ CCC_CODEX_HOOK_FILE: file, CLAUDE_MULTI_SESSION_ID: 'sess-1' })).not.toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  it('never reads through a file link', (ctx) => {
    const dir = hookDir()
    const target = join(dirname(dir), 'real.json')
    writeFileSync(target, JSON.stringify({ v: 1, port: 51234, sid: 'sess-1', token: TOKEN }))
    const link = join(dir, 'hook.json')
    // Skipped, visibly, where the host gives no right to make a file link (Windows without it).
    try { symlinkSync(target, link); links.push(link) } catch { ctx.skip(); return }
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

  it('posts the body as read to 127.0.0.1 only, with the token and the Codex marker, and no shared agent', async () => {
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
    expect(o.agent).toBe(false)
    expect(o.headers['x-ccc-hook-token']).toBe(TOKEN)
    expect(o.headers['x-ccc-hook-client']).toBe('codex')
    expect(o.headers['content-length']).toBe(body.length)
    expect(typeof o.timeout).toBe('number')
    expect(o.timeout).toBeLessThanOrEqual(2000)
    expect(captured[0].body?.equals(body)).toBe(true)
    expect(done).toBe(1)
  })

  it('never goes through a proxy the environment names: a stand-in proxy sees nothing, the gateway gets the event (round 1)', async (ctx) => {
    const hits: Array<{ who: string; url: string; token?: string }> = []
    const listen = (who: string) => new Promise<http.Server>((resolve) => {
      const s = httpMod.createServer((req, res) => {
        hits.push({ who, url: req.url ?? '', token: req.headers['x-ccc-hook-token'] as string | undefined })
        req.resume()
        req.on('end', () => res.end('{}'))
      })
      s.listen(0, '127.0.0.1', () => resolve(s))
    })
    const gw = await listen('gateway')
    const proxy = await listen('proxy')
    const saved = httpMod.globalAgent
    try {
      // What NODE_USE_ENV_PROXY with HTTP_PROXY set gives every request that
      // takes the shared agent (Node 24; no loopback exception).
      ;(httpMod as { globalAgent: http.Agent }).globalAgent = new httpMod.Agent({ proxyEnv: { HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}` } } as http.AgentOptions)
      const port = (gw.address() as AddressInfo).port
      // Canary: a request on the shared agent does reach the proxy here; where
      // it does not (a Node without environment proxies), there is nothing to
      // show and the case is skipped, visibly.
      await new Promise<void>((resolve) => {
        const r = httpMod.request({ host: '127.0.0.1', port, path: '/canary', method: 'POST' }, (res) => { res.resume(); res.on('end', resolve) })
        r.on('error', () => resolve())
        r.end('{}')
      })
      const proxied = hits.some((h) => h.who === 'proxy')
      hits.length = 0
      if (!proxied) { ctx.skip(); return }
      await new Promise<void>((resolve) => fwd.forward({ port, sid: 'sess-1', token: TOKEN }, Buffer.from('{"hook_event_name":"UserPromptSubmit","prompt":"secret prompt"}'), resolve))
      expect(hits.filter((h) => h.who === 'proxy')).toEqual([])
      expect(hits).toEqual([{ who: 'gateway', url: '/hook/sess-1', token: TOKEN }])
    } finally {
      ;(httpMod as { globalAgent: http.Agent }).globalAgent = saved
      gw.close()
      proxy.close()
    }
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
