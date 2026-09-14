// tests/unit/pty-manager-tmux-download.test.ts
//
// #242 tier 4, follow-up adversarial pass (coverage MAJOR): every guard in
// pty-manager's host-side downloadAndCacheTmuxArchive was previously
// unreachable from the suite -- attemptTmuxPush goes through the
// tmuxArchiveResolver seam, which pty-manager-ssh-tmux.test.ts stubs ABOVE
// this level, so raising TMUX_ARCHIVE_MAX_BYTES to Number.MAX_SAFE_INTEGER
// or deleting the https-only redirect refusal left the whole targeted suite
// green. These tests drive the REAL function (via the
// _downloadAndCacheTmuxArchiveForTest export) with a mocked `https` module:
// an EventEmitter-based IncomingMessage-alike plus a fake ClientRequest, so
// every wire-level guard (size cap, redirect policy, sha256 pin, request
// timeouts, status handling, cache-write resilience) can actually fail.
//
// Mock harness (os / node-pty / electron) copied from
// pty-manager-ssh-tmux.test.ts, which proves pty-manager's import graph
// loads under vitest with exactly these three mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import * as crypto from 'crypto'

// vi.mock factories are hoisted above every import, so the mutable state they
// close over must be hoisted too.
const h = vi.hoisted(() => ({
  // Installed per-test; null = "no https.get expected yet". The wrapper in the
  // factory below throws when called with no impl installed, which the source
  // converts to a resolve(null) via its own try/catch -- tests therefore
  // always ALSO assert on the recorded call count, not just the null result.
  getImpl: null as null | ((url: unknown, options: unknown, cb: unknown) => unknown),
  // What the mocked electron app.getPath('userData') returns -- pty-manager's
  // tmuxCacheDir() reads it lazily per call, so tests can point it at a fresh
  // temp dir (or at a deliberately unwritable path) before each download.
  userDataDir: '',
}))

vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  platform: () => 'linux',
}))
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('electron', () => ({
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  app: { getPath: () => h.userDataDir },
}))
// pty-manager does `import * as https from 'https'` (bare specifier, not
// node:https) -- spread the real module so anything else in the import graph
// keeps working, and override only `get`.
vi.mock('https', async (importOriginal) => {
  const real = await importOriginal<typeof import('https')>()
  const get = (...args: unknown[]): unknown => {
    if (!h.getImpl) throw new Error('https.get called before the test installed an impl')
    return h.getImpl(args[0], args[1], args[2])
  }
  return { ...real, get, default: { ...real, get } }
})

const { _downloadAndCacheTmuxArchiveForTest } = await import('../../src/main/pty-manager')
const { TMUX_STAGE_SHA256, tmuxStageAssetUrl } = await import('../../src/main/ssh-tmux-stage')
type TmuxStageTarget = keyof typeof TMUX_STAGE_SHA256

const ARCH: TmuxStageTarget = 'linux-x86_64'
const ASSET_URL = tmuxStageAssetUrl(ARCH)
const CAP_BYTES = 8 * 1024 * 1024 // mirrors TMUX_ARCHIVE_MAX_BYTES (module-private)
const REQUEST_TIMEOUT_MS = 20000 // mirrors TMUX_DOWNLOAD_REQUEST_TIMEOUT_MS (module-private)

/** IncomingMessage-alike: statusCode + headers + resume/destroy spies, with
 *  data/end/error delivered via real EventEmitter semantics. */
class FakeRes extends EventEmitter {
  statusCode: number | undefined
  headers: Record<string, string | undefined>
  resume = vi.fn()
  destroy = vi.fn()
  constructor(statusCode: number | undefined, headers: Record<string, string | undefined> = {}) {
    super()
    this.statusCode = statusCode
    this.headers = headers
  }
}

/** ClientRequest-alike. destroy(err) emits 'error' the way a real destroyed
 *  request does, so the source's req.on('error') fallback path runs. */
class FakeReq extends EventEmitter {
  destroy = vi.fn((err?: Error) => {
    this.emit('error', err ?? new Error('destroyed'))
  })
}

interface RecordedGet {
  url: string
  options: { timeout?: number } | undefined
  req: FakeReq
}

type GetHandler = (cb: (res: unknown) => void, req: FakeReq, call: RecordedGet) => void

/**
 * Script the mocked https.get: the Nth call is served by handlers[N]. Returns
 * the recorded calls (url as a string -- the source passes a string for the
 * initial request and a WHATWG URL for redirect hops; String() covers both).
 * A call beyond the script throws, which the source's try/catch converts to
 * resolve(null) -- the recorded call COUNT is what catches that case.
 */
function scriptGets(handlers: GetHandler[]): RecordedGet[] {
  const calls: RecordedGet[] = []
  h.getImpl = (rawUrl, rawOptions, rawCb) => {
    const req = new FakeReq()
    const call: RecordedGet = {
      url: String(rawUrl),
      options: rawOptions as { timeout?: number } | undefined,
      req,
    }
    calls.push(call)
    const handler = handlers[calls.length - 1]
    if (!handler) throw new Error(`unexpected https.get call #${calls.length} to ${call.url}`)
    handler(rawCb as (res: unknown) => void, req, call)
    return req
  }
  return calls
}

/** Serve a 200 whose body arrives in `chunks`, then ends. */
function serveBody(chunks: Buffer[]): GetHandler {
  return (cb) => {
    const res = new FakeRes(200)
    cb(res)
    for (const c of chunks) res.emit('data', c)
    res.emit('end')
  }
}

/** Serve a redirect status carrying a Location header. */
function serveRedirect(location: string | undefined, statusCode = 302): { handler: GetHandler; res: () => FakeRes } {
  let served: FakeRes | undefined
  return {
    handler: (cb) => {
      served = new FakeRes(statusCode, { location })
      cb(served)
    },
    res: () => {
      if (!served) throw new Error('redirect response never served')
      return served
    },
  }
}

function sha256Hex(bufs: Buffer[]): string {
  const hash = crypto.createHash('sha256')
  for (const b of bufs) hash.update(b)
  return hash.digest('hex')
}

// The pinned digests point at the real v3.7b archives, which these tests
// obviously don't ship -- so tests that need the digest gate to PASS mutate
// the (plain-object, const-binding-only) TMUX_STAGE_SHA256 entry to the test
// body's own hash, exactly the technique ssh-tmux-stage.test.ts already uses
// for its corrupted-digest guard test. Restored after every test.
const REAL_SHA256 = { ...TMUX_STAGE_SHA256 }

const tempDirs: string[] = []
function freshUserDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-tmux-dl-'))
  tempDirs.push(dir)
  h.userDataDir = dir
  return dir
}
function cachePathIn(userDataDir: string): string {
  return path.join(userDataDir, 'tmux-cache', `tmux-${ARCH}.tar.gz`)
}

beforeEach(() => {
  freshUserDataDir()
})

afterEach(() => {
  h.getImpl = null
  Object.assign(TMUX_STAGE_SHA256, REAL_SHA256)
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

describe('downloadAndCacheTmuxArchive (tier-4 host-side downloader)', () => {
  describe('success path', () => {
    it('fetches the pinned per-arch asset URL, resolves the verified bytes, and writes them to the cache dir', async () => {
      const body = Buffer.from('fake-tmux-archive-payload')
      TMUX_STAGE_SHA256[ARCH] = sha256Hex([body])
      const calls = scriptGets([serveBody([body])])

      const result = await _downloadAndCacheTmuxArchiveForTest(ARCH)

      expect(calls).toHaveLength(1)
      // #242 F6: the host-side downloader and the remote curl/wget script must
      // fetch the SAME pinned URL.
      expect(calls[0].url).toBe(ASSET_URL)
      expect(result).not.toBeNull()
      expect(result!.equals(body)).toBe(true)
      // Verified bytes are cached for the next session needing this arch.
      const cached = fs.readFileSync(cachePathIn(h.userDataDir))
      expect(cached.equals(body)).toBe(true)
    })

    it('still resolves the verified bytes when the cache write throws', async () => {
      // Point userData at an existing FILE: mkdirSync('<file>/tmux-cache')
      // inside the cache-write try block then throws for real -- no fs mock.
      const parent = freshUserDataDir()
      const blocker = path.join(parent, 'blocker-file')
      fs.writeFileSync(blocker, 'not a directory')
      h.userDataDir = blocker

      const body = Buffer.from('cache-write-will-fail-payload')
      TMUX_STAGE_SHA256[ARCH] = sha256Hex([body])
      scriptGets([serveBody([body])])

      const result = await _downloadAndCacheTmuxArchiveForTest(ARCH)

      // The cache write really did fail...
      expect(fs.existsSync(cachePathIn(blocker))).toBe(false)
      // ...and that must NOT invalidate the already-verified bytes in hand.
      expect(result).not.toBeNull()
      expect(result!.equals(body)).toBe(true)
    })
  })

  describe('size cap (TMUX_ARCHIVE_MAX_BYTES, enforced on the wire)', () => {
    it('destroys the response and resolves null the moment the body exceeds 8 MiB, without buffering on', async () => {
      const big = Buffer.alloc(4 * 1024 * 1024) // reused -- never allocate the overage repeatedly
      const one = Buffer.alloc(1)
      // If the cap were absent, the FULL emitted body (8 MiB + 1 + 4 MiB)
      // would assemble and VERIFY -- so a mutated/removed cap makes this test
      // fail on the result too, not only on the destroy assertion.
      TMUX_STAGE_SHA256[ARCH] = sha256Hex([big, big, one, big])
      let res!: FakeRes
      scriptGets([
        (cb) => {
          res = new FakeRes(200)
          cb(res)
          res.emit('data', big) // 4 MiB
          res.emit('data', big) // 8 MiB exactly -- still allowed (cap is >, not >=)
          expect(res.destroy).not.toHaveBeenCalled()
          res.emit('data', one) // 8 MiB + 1 -- over the cap
          // A misbehaving server keeps sending after the destroy: the handler
          // must short-circuit, not keep accumulating or destroy again.
          res.emit('data', big)
          res.emit('end')
        },
      ])

      const result = await _downloadAndCacheTmuxArchiveForTest(ARCH)

      expect(res.destroy).toHaveBeenCalledTimes(1)
      expect(result).toBeNull()
      // Nothing over-limit ever lands in the cache.
      expect(fs.existsSync(cachePathIn(h.userDataDir))).toBe(false)
    })

    it('accepts a body of exactly 8 MiB (the cap is exclusive)', async () => {
      const big = Buffer.alloc(4 * 1024 * 1024)
      TMUX_STAGE_SHA256[ARCH] = sha256Hex([big, big])
      let res!: FakeRes
      scriptGets([
        (cb) => {
          res = new FakeRes(200)
          cb(res)
          res.emit('data', big)
          res.emit('data', big)
          res.emit('end')
        },
      ])

      const result = await _downloadAndCacheTmuxArchiveForTest(ARCH)

      expect(res.destroy).not.toHaveBeenCalled()
      expect(result).not.toBeNull()
      expect(result!.length).toBe(CAP_BYTES)
    })
  })

  describe('redirect policy', () => {
    it('follows a cross-host https Location (the real GitHub-to-S3 shape) and resolves the redirected body', async () => {
      const signedUrl = 'https://objects.example-cdn.test/signed/tmux.tar.gz?token=abc'
      const body = Buffer.from('redirected-archive-bytes')
      TMUX_STAGE_SHA256[ARCH] = sha256Hex([body])
      const redirect = serveRedirect(signedUrl)
      const calls = scriptGets([redirect.handler, serveBody([body])])

      const result = await _downloadAndCacheTmuxArchiveForTest(ARCH)

      expect(calls).toHaveLength(2)
      expect(calls[1].url).toBe(signedUrl)
      // The redirect response's body is drained, not left dangling.
      expect(redirect.res().resume).toHaveBeenCalled()
      expect(result).not.toBeNull()
      expect(result!.equals(body)).toBe(true)
    })

    it('resolves a relative Location against the current request URL, the way browsers/curl do', async () => {
      const body = Buffer.from('relative-redirect-bytes')
      TMUX_STAGE_SHA256[ARCH] = sha256Hex([body])
      const redirect = serveRedirect('/rel/asset.tar.gz')
      const calls = scriptGets([redirect.handler, serveBody([body])])

      const result = await _downloadAndCacheTmuxArchiveForTest(ARCH)

      expect(calls).toHaveLength(2)
      expect(calls[1].url).toBe(new URL('/rel/asset.tar.gz', ASSET_URL).toString())
      expect(result).not.toBeNull()
      expect(result!.equals(body)).toBe(true)
    })

    it('refuses a Location that resolves to a non-https scheme: null, and NO further request is made', async () => {
      const redirect = serveRedirect('http://captive-portal.test/login')
      const calls = scriptGets([redirect.handler])

      const result = await _downloadAndCacheTmuxArchiveForTest(ARCH)

      expect(result).toBeNull()
      // The refusal must happen BEFORE any second https.get -- a mutated
      // guard that "follows then fails" would record a second call here.
      expect(calls).toHaveLength(1)
    })

    it('resolves null on a malformed Location instead of throwing out of the response callback', async () => {
      // 'http://' has a scheme (so the base is ignored) but no host --
      // new URL('http://', base) throws ERR_INVALID_URL.
      const redirect = serveRedirect('http://')
      const calls = scriptGets([redirect.handler])

      const result = await _downloadAndCacheTmuxArchiveForTest(ARCH)

      expect(result).toBeNull()
      expect(calls).toHaveLength(1)
    })

    it('follows at most 2 redirect hops: a third consecutive redirect is not followed', async () => {
      const hop1 = serveRedirect('https://r1.example.test/a')
      const hop2 = serveRedirect('https://r2.example.test/b')
      // The third response is ANOTHER redirect, but redirectsLeft is now 0 --
      // it must be treated as a terminal (empty-body) response, not followed.
      const calls = scriptGets([
        hop1.handler,
        hop2.handler,
        (cb) => {
          const res = new FakeRes(302, { location: 'https://r3.example.test/c' })
          cb(res)
          res.emit('end') // empty body -> digest mismatch -> null
        },
      ])

      const result = await _downloadAndCacheTmuxArchiveForTest(ARCH)

      expect(calls).toHaveLength(3) // initial + exactly 2 followed hops, never a 4th request
      expect(calls[1].url).toBe('https://r1.example.test/a')
      expect(calls[2].url).toBe('https://r2.example.test/b')
      expect(result).toBeNull()
    })
  })

  describe('sha256 pin', () => {
    it('resolves null and caches nothing when the body does not match the pinned per-arch digest', async () => {
      // Real pinned digest left in place: this body cannot match it.
      const calls = scriptGets([serveBody([Buffer.from('definitely-not-the-real-archive')])])

      const result = await _downloadAndCacheTmuxArchiveForTest(ARCH)

      expect(calls).toHaveLength(1)
      expect(result).toBeNull()
      // A digest-failing body must never land in the cache either.
      expect(fs.existsSync(cachePathIn(h.userDataDir))).toBe(false)
    })
  })

  describe('request timeouts', () => {
    it('passes a 20s timeout option on the initial request and destroys it when the timeout fires', async () => {
      const calls = scriptGets([
        () => {
          /* never respond -- the request is going to time out */
        },
      ])

      const pending = _downloadAndCacheTmuxArchiveForTest(ARCH)
      expect(calls).toHaveLength(1)
      expect(calls[0].options?.timeout).toBe(REQUEST_TIMEOUT_MS)
      // The 'timeout' event alone aborts nothing in node -- only the handler
      // destroying the request does. FakeReq.destroy emits 'error', which the
      // source's error handler turns into the null resolution awaited below.
      calls[0].req.emit('timeout')
      expect(calls[0].req.destroy).toHaveBeenCalledTimes(1)
      expect(calls[0].req.destroy.mock.calls[0][0]).toBeInstanceOf(Error)

      await expect(pending).resolves.toBeNull()
    })

    it('passes the same 20s timeout on the redirect hop and destroys it when the timeout fires', async () => {
      const redirect = serveRedirect('https://objects.example-cdn.test/slow')
      const calls = scriptGets([
        redirect.handler,
        () => {
          /* redirect hop never responds */
        },
      ])

      const pending = _downloadAndCacheTmuxArchiveForTest(ARCH)
      expect(calls).toHaveLength(2)
      expect(calls[1].options?.timeout).toBe(REQUEST_TIMEOUT_MS)
      calls[1].req.emit('timeout')
      expect(calls[1].req.destroy).toHaveBeenCalledTimes(1)

      await expect(pending).resolves.toBeNull()
    })
  })

  describe('error statuses', () => {
    it('resolves null on a 4xx, draining the response', async () => {
      let res!: FakeRes
      scriptGets([
        (cb) => {
          res = new FakeRes(404)
          cb(res)
        },
      ])

      await expect(_downloadAndCacheTmuxArchiveForTest(ARCH)).resolves.toBeNull()
      expect(res.resume).toHaveBeenCalled()
    })

    it('resolves null on a 5xx', async () => {
      scriptGets([(cb) => cb(new FakeRes(500))])
      await expect(_downloadAndCacheTmuxArchiveForTest(ARCH)).resolves.toBeNull()
    })

    it('resolves null when the response carries no status code at all', async () => {
      scriptGets([(cb) => cb(new FakeRes(undefined))])
      await expect(_downloadAndCacheTmuxArchiveForTest(ARCH)).resolves.toBeNull()
    })
  })
})
