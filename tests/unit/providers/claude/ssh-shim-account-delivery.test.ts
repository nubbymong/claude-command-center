// tests/unit/providers/claude/ssh-shim-account-delivery.test.ts
//
// FIX (2026-09-01): the SSH top-bar account pills took seconds -- or seemed
// never -- to appear on a first (COLD) connect. Root cause: the statusline
// shim (SSH_STATUSLINE_SHIM, ssh-shim.ts) delivered the remote account to the
// local Conductor ONLY inside the fetchUsage callback --
// `fetchUsage(function(lim){applyUsage(lim);deliver();})` -- and on a cold
// connect fetchUsage does a live 5 s HTTPS GET to api.anthropic.com (no
// ~/.claude/ccc-usage-cache-*.json yet). The account is already in the payload
// `s` from SHIM_GATHER_JS (a zero-network ~/.claude.json read), so it had no
// business waiting on a usage fetch. The fix delivers ONCE immediately (POST
// path only) and again when usage resolves.
//
// This runs the shim's REAL source (extracted from generateRemoteSetupScript's
// output, the exact bytes written to the remote) with `require('http')` /
// `require('https')` substituted for scripted stand-ins, so the ORDER in which
// the two POSTs fire -- and what each carries -- is what is under test, not a
// restatement of it. Sibling to ssh-shim-runtime-harness.test.ts (which covers
// the OSC-ladder branch); this one drives the tunnel POST branch.
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'events'
import * as nodePath from 'path'
import { generateRemoteSetupScript } from '../../../../src/main/providers/claude/ssh-shim'

const NONCE = 'acctnonce123abc'
// argv[3] starting with 'http' is used directly as the tunnel URL (no file
// read) -- see SHIM_STATUS_URL_JS in statusline-gather.ts.
const STATUS_URL = 'http://127.0.0.1:19333/status?cccSessionId=sid-acct&token=abc123'
const REMOTE_EMAIL = 'cold@example.com'

/** Pull the shim's REAL source out of the REAL setup script (same technique as
 *  ssh-shim-runtime-harness.test.ts) so this test cannot drift from the bytes
 *  the remote actually runs. */
function extractShimSource(): string {
  const script = generateRemoteSetupScript('sid-acct', null, undefined, NONCE)
  const marker = 'fs.writeFileSync(shimPath,'
  const idx = script.indexOf(marker)
  expect(idx).toBeGreaterThan(-1)
  const rest = script.slice(idx + marker.length)
  const endMarker = ",{mode:0o755,flag:'wx'})"
  const endIdx = rest.indexOf(endMarker)
  expect(endIdx).toBeGreaterThan(-1)
  const source: string = JSON.parse(rest.slice(0, endIdx))
  return source.replace(/^#!.*\n/, '')
}

interface RunResult {
  /** Parsed bodies of every tunnel POST, in the order they fired. */
  posts: Array<Record<string, unknown>>
  /** Call to resolve the (otherwise hanging) fetchUsage HTTPS request with the
   *  given usage JSON body; simulates api.anthropic.com finally answering. */
  resolveUsage: (usageJson: string) => void
  /** True once the fetchUsage HTTPS request has been issued (i.e. the shim
   *  reached the cold-fetch path rather than short-circuiting). */
  httpsIssued: () => boolean
}

/**
 * Run the shim with a signed-in account, a valid OAuth token, and NO usage
 * cache -- the cold-connect shape. `require('https')` (fetchUsage) is captured
 * and left HANGING until the test chooses to resolve it, so any POST that fires
 * before then proves it did not wait on the usage fetch.
 */
function runShimColdConnect(shimSource: string): RunResult {
  const posts: Array<Record<string, unknown>> = []
  let httpsResCb: ((res: unknown) => void) | null = null

  const fakeFs = {
    appendFileSync: () => {},
    // ~/.claude.json is small -> the account is read into `s` (SHIM_GATHER_JS).
    statSync: () => ({ size: 100, isCharacterDevice: () => false }),
    existsSync: (p: string) => p.endsWith('.credentials.json'),
    readFileSync: (p: string) => {
      if (p.endsWith('.claude.json')) return JSON.stringify({ oauthAccount: { emailAddress: REMOTE_EMAIL } })
      if (p.endsWith('.credentials.json')) return JSON.stringify({ claudeAiOauth: { accessToken: 'tok-abc' } })
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    // No usage cache on a cold connect -> fetchUsage falls through to the live
    // HTTPS fetch.
    lstatSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
    mkdirSync: () => {},
    rmSync: () => {},
    writeFileSync: () => {},
    readlinkSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
  }
  const fakeHttp = {
    request: (_opts: unknown, cb: (res: unknown) => void) => {
      const req = {
        on: () => req,
        write: () => {},
        destroy: () => {},
        end: (body?: string) => {
          if (body) posts.push(JSON.parse(body))
          // Answer 200 so deliver()'s `fin` reports success (never falls to the
          // OSC ladder), synchronously -- the immediate POST completes in the
          // same tick it is issued.
          cb({ resume: () => {}, statusCode: 200 })
        },
      }
      return req
    },
  }
  const fakeHttps = {
    request: (_opts: unknown, cb: (res: unknown) => void) => {
      httpsResCb = cb // capture; do NOT call -> fetchUsage hangs until resolveUsage
      return { on: () => fakeHttps, end: () => {}, destroy: () => {} }
    },
  }
  const fakeRequire = (name: string): unknown => {
    if (name === 'fs') return fakeFs
    if (name === 'os') return { homedir: () => '/fake-home' }
    if (name === 'path') return nodePath.posix
    if (name === 'http') return fakeHttp
    if (name === 'https') return fakeHttps
    if (name === 'child_process') return { execFileSync: () => '' }
    throw new Error('ssh-shim-account-delivery: unexpected require: ' + name)
  }
  const fakeStdin = Object.assign(new EventEmitter(), { setEncoding: () => {} })
  const fakeProcess = {
    env: {} as Record<string, string>,
    pid: 4242,
    // argv[2] = sid, argv[3] = the tunnel URL (starts 'http' -> used directly).
    argv: ['node', '/fake-home/.claude/conductor-ssh-statusline.js', 'sid-acct', STATUS_URL],
    platform: 'linux',
    stdin: fakeStdin,
    stdout: { write: () => true },
    stderr: { write: () => true },
  }
  // eslint-disable-next-line no-new-func -- deliberate: this IS the harness.
  const runner = new Function('require', 'process', shimSource)
  runner(fakeRequire, fakeProcess)
  fakeStdin.emit('data', JSON.stringify({ context_window: {}, cost: {} }))
  fakeStdin.emit('end')

  const resolveUsage = (usageJson: string) => {
    if (!httpsResCb) throw new Error('fetchUsage HTTPS request was never issued')
    const dataHandlers: Array<(c: string) => void> = []
    const endHandlers: Array<() => void> = []
    const resU = {
      on: (ev: string, h: (c?: string) => void) => {
        if (ev === 'data') dataHandlers.push(h as (c: string) => void)
        if (ev === 'end') endHandlers.push(h as () => void)
        return resU
      },
    }
    httpsResCb(resU) // shim registers its data/end handlers synchronously here
    for (const h of dataHandlers) h(usageJson)
    for (const h of endHandlers) h()
  }
  return { posts, resolveUsage, httpsIssued: () => httpsResCb !== null }
}

const USAGE_JSON = JSON.stringify({
  limits: [
    { group: 'weekly', kind: 'model', percent: 42, resets_at: '2026-09-02T00:00:00Z', severity: 'normal', scope: { model: { display_name: 'Fable' } } },
  ],
})

describe('SSH statusline shim -- account delivered before the cold usage fetch (tunnel POST)', () => {
  // Mutation to prove this can fail: revert the fix (drop `if(statusUrl){deliver();}`
  // so the only deliver() is inside the fetchUsage callback). With fetchUsage
  // hanging, NO post fires -> posts.length is 0 and this assertion fails.
  it('POSTs the account IMMEDIATELY, while the usage fetch is still hanging', () => {
    const { posts, httpsIssued } = runShimColdConnect(extractShimSource())
    // The cold-fetch path was actually taken (no cache -> live HTTPS issued)...
    expect(httpsIssued()).toBe(true)
    // ...and yet the account POST already fired, without waiting on it.
    expect(posts).toHaveLength(1)
    expect(posts[0].accountEmail).toBe(REMOTE_EMAIL)
    // The immediate POST carries the account but not yet the fetched buckets.
    expect(posts[0].usageBuckets).toBeUndefined()
  })

  it('POSTs again when usage resolves, merging buckets WITHOUT clobbering the account (idempotent second POST)', () => {
    const { posts, resolveUsage } = runShimColdConnect(extractShimSource())
    expect(posts).toHaveLength(1) // the immediate account POST
    resolveUsage(USAGE_JSON)
    // The second POST fires only after usage lands...
    expect(posts).toHaveLength(2)
    // ...and it still carries the account (not clobbered) AND now the buckets.
    expect(posts[1].accountEmail).toBe(REMOTE_EMAIL)
    expect(Array.isArray(posts[1].usageBuckets)).toBe(true)
    expect((posts[1].usageBuckets as unknown[]).length).toBe(1)
    // The store copies each field only when present (useStatuslineSubscription),
    // so a first POST without usageBuckets never wipes the second's, and the
    // account is present in BOTH posts -- the merge is safe in either order.
    expect(posts[0].accountEmail).toBe(REMOTE_EMAIL)
  })
})
