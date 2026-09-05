// @vitest-environment node
//
// readClaudeCliAuth — the CODE-session auth resolver (#258). Nothing tested this
// end to end, which is why a credential-file path that could never resolve
// shipped: it omitted the `.claude` segment every writer/reader uses, so a
// signed-in account rendered "not signed in" whenever the CLI probe failed.
//
// These tests use a REAL temp dir (real fs) and mock only the profile-root
// resolvers and the CLI subprocess, so the path the code actually joins is under
// test — revert the `.claude` fix and the credential-file case goes RED.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

let root: string

// Per-test CLI behaviour. Default: the CLI errors (absent/slow/non-zero), which
// is the common real case and the one that forced the file fallback into use.
// Mock shape matches util.promisify(child_process.execFile): resolve the 2nd
// callback arg as { stdout, stderr }.
type ExecCb = (err: Error | null, res?: { stdout: string; stderr: string }) => void
let execFileImpl: (cmd: string, args: string[], opts: unknown, cb: ExecCb) => void

vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], opts: unknown, cb: ExecCb) => execFileImpl(cmd, args, opts, cb),
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('../../src/main/account-profiles', () => ({
  getProfilesRoot: () => root,
  getProfileConfigDir: (id: string) => join(root, id),
}))

const { readClaudeCliAuth } = await import('../../src/main/account-web/claude-cli-auth')
const { hasTransientProfileConsumer, noteProfileRefreshInFlight, _resetProfileConsumersForTest } = await import('../../src/main/profile-consumers')

const ID = 'profile-abc-123'
const NOW = 1_700_000_000_000

function writeCredFile(id: string, relDir: string) {
  const dir = join(root, id, relDir)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    join(dir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'tok', subscriptionType: 'max', expiresAt: NOW } }),
  )
}

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'ccc-cli-auth-'))
  execFileImpl = (_cmd, _args, _opts, cb) => cb(new Error('no cli'))
  _resetProfileConsumersForTest()
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('readClaudeCliAuth — credential-file fallback path', () => {
  it('finds the file at <home>/.claude/.credentials.json (the path every writer uses)', async () => {
    writeCredFile(ID, '.claude')
    const r = await readClaudeCliAuth(ID)
    expect(r.authenticated).toBe(true)
    expect(r.source).toBe('credential-file')
    expect(r.subscriptionType).toBe('max')
  })

  it('does NOT resolve a file at the old profile-root path (the shipped bug)', async () => {
    // The file at <home>/.credentials.json — where the pre-fix code looked — must
    // NOT count as signed in, because nothing in the app ever writes it there.
    writeCredFile(ID, '.') // <home>/.credentials.json
    const r = await readClaudeCliAuth(ID)
    expect(r.authenticated).toBe(false)
  })

  it('reports not-signed-in (no error) when neither the CLI nor a file answers', async () => {
    fs.mkdirSync(join(root, ID), { recursive: true }) // home exists, no creds
    const r = await readClaudeCliAuth(ID)
    expect(r.authenticated).toBe(false)
    expect(r.source).toBeUndefined()
  })

  it('rejects a traversal id before touching the filesystem', async () => {
    const r = await readClaudeCliAuth('../../etc')
    expect(r.authenticated).toBe(false)
    expect(r.error).toMatch(/could not determine/)
  })
})

describe('readClaudeCliAuth — CLI probe preferred, and registered as a consumer', () => {
  it('returns the CLI status (with the identity the file cannot carry) when it answers', async () => {
    fs.mkdirSync(join(root, ID), { recursive: true })
    execFileImpl = (_c, _a, _o, cb) =>
      cb(null, { stdout: JSON.stringify({ loggedIn: true, email: 'a@example.com', orgName: 'Acme' }), stderr: '' })
    const r = await readClaudeCliAuth(ID)
    expect(r.authenticated).toBe(true)
    expect(r.email).toBe('a@example.com')
    expect(r.source).toBe('cli-status')
  })

  it('marks the profile in-use FOR THE DURATION of the probe, then releases it', async () => {
    fs.mkdirSync(join(root, ID), { recursive: true })
    let inUseDuringProbe: boolean | undefined
    execFileImpl = (_c, _a, _o, cb) => {
      // The auto token-refresh guard reads exactly this while the probe runs.
      inUseDuringProbe = hasTransientProfileConsumer(ID)
      cb(null, { stdout: JSON.stringify({ loggedIn: true }), stderr: '' })
    }
    expect(hasTransientProfileConsumer(ID)).toBe(false)
    await readClaudeCliAuth(ID)
    expect(inUseDuringProbe).toBe(true)
    // Released in the finally — no leak that would block refresh forever.
    expect(hasTransientProfileConsumer(ID)).toBe(false)
  })

  it('releases the consumer even when the probe throws', async () => {
    fs.mkdirSync(join(root, ID), { recursive: true })
    execFileImpl = (_c, _a, _o, cb) => cb(new Error('boom'))
    await readClaudeCliAuth(ID)
    expect(hasTransientProfileConsumer(ID)).toBe(false)
  })

  it('coalesces overlapping probes for one profile into a single subprocess', async () => {
    // Making the probe async removed the execFileSync serialisation, so a panel
    // opening N accounts could fan out N concurrent `claude` trees. Two overlapping
    // probes for the same profile must share ONE subprocess (and one consumer ref).
    fs.mkdirSync(join(root, ID), { recursive: true })
    let calls = 0
    let pending: ExecCb | null = null
    execFileImpl = (_c, _a, _o, cb) => { calls++; pending = cb }

    const p1 = readClaudeCliAuth(ID)
    const p2 = readClaudeCliAuth(ID)
    expect(calls).toBe(1)                       // one subprocess covers both callers
    expect(hasTransientProfileConsumer(ID)).toBe(true) // and exactly one consumer ref

    pending!(null, { stdout: JSON.stringify({ loggedIn: true, email: 'a@example.com' }), stderr: '' })
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.email).toBe('a@example.com')
    expect(r2.email).toBe('a@example.com')
    expect(hasTransientProfileConsumer(ID)).toBe(false) // released once, not leaked

    // The in-flight entry clears on settle, so a later probe is not blocked.
    const p3 = readClaudeCliAuth(ID)
    expect(calls).toBe(2)
    pending!(null, { stdout: JSON.stringify({ loggedIn: true }), stderr: '' })
    await p3
  })
})

// #49 (rc.14 review F5): the probe is the consumer the ticket names. Registering
// as a consumer stops a LATER refresh; it cannot stop one already in flight, and
// a CLI spawned mid-rotation reads the pre-rotation credential file. So the probe
// waits for the rotation to land before it spawns.
describe('readClaudeCliAuth — starting mid-rotation waits for the refresh (#49)', () => {
  const tick = async (n = 4) => { for (let i = 0; i < n; i++) await Promise.resolve() }

  it('does not spawn the CLI until the in-flight refresh settles, then probes and releases as usual', async () => {
    fs.mkdirSync(join(root, ID), { recursive: true })
    let execCalls = 0
    execFileImpl = (_cmd, _args, _opts, cb) => { execCalls++; cb(new Error('no cli')) }
    let settle!: (v: unknown) => void
    noteProfileRefreshInFlight(ID, new Promise((resolve) => { settle = resolve }))

    const probe = readClaudeCliAuth(ID)
    await tick()
    expect(execCalls).toBe(0)                          // not spawned: the file is mid-rotation
    expect(hasTransientProfileConsumer(ID)).toBe(false) // and nothing held yet

    settle({ accessToken: 'new' })
    const r = await probe
    expect(execCalls).toBe(1)
    expect(r.authenticated).toBe(false)                // (no CLI, no file) -- the probe still completed
    expect(hasTransientProfileConsumer(ID)).toBe(false) // released in the finally
  })

  it('a refresh of another profile does not delay the probe', async () => {
    fs.mkdirSync(join(root, ID), { recursive: true })
    let execCalls = 0
    execFileImpl = (_cmd, _args, _opts, cb) => { execCalls++; cb(new Error('no cli')) }
    noteProfileRefreshInFlight('profile-other-9', new Promise(() => { /* never settles */ }))
    await readClaudeCliAuth(ID)
    expect(execCalls).toBe(1)
  })
})
