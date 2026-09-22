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
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { composeProviders } from '../../src/main/providers/compose'

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
// `logWarn` belongs in this mock's surface, not as an afterthought: the managed
// launch path warns, and a mock that omits a function the code under test calls
// turns a log line into a TypeError -- which the probe's own catch then reports
// as "the CLI did not answer", i.e. exactly the silent fallback these tests
// exist to catch.
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
// Only the two profile-root resolvers are faked. `withProfileHome` is the REAL
// one on purpose: it is what applies the managed-launch hardening to this auth
// probe, so stubbing it would leave the assertion below testing a stub.
vi.mock('../../src/main/account-profiles', async () => ({
  ...(await vi.importActual<typeof import('../../src/main/account-profiles')>('../../src/main/account-profiles')),
  getProfilesRoot: () => root,
  getProfileConfigDir: (id: string) => join(root, id),
}))

const { readClaudeCliAuth } = await import('../../src/main/account-web/claude-cli-auth')
const { hasTransientProfileConsumer, noteProfileRefreshInFlight, _resetProfileConsumersForTest } = await import('../../src/main/profile-consumers')
// The probe's own project gate. `peekGateVerdict` is how the test proves the
// probe RAN the gate for the directory it inherits: withProfileHome refuses a
// launch that names a cwd and carries no verdict, so a probe that reached
// execFile must have passed one -- and this says WHICH directory it gated.
const { gateManagedLaunch, peekGateVerdict, _resetProjectScanStateForTest } = await import('../../src/main/managed-launch-diagnostics')

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

// `claude auth status` is a managed launch: its environment now comes from
// withProfileHome, which takes the Claude package's ambient-strip list and the
// realm variables it owns from the registry. Compose the way boot does, or every
// CLI probe throws before it spawns and silently falls through to the file path
// -- which is precisely the failure these tests exist to catch.
beforeAll(() => { composeProviders() })

beforeEach(async () => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'ccc-cli-auth-'))
  execFileImpl = (_cmd, _args, _opts, cb) => cb(new Error('no cli'))
  _resetProfileConsumersForTest()
  _resetProjectScanStateForTest()
  // The probe stays SYNCHRONOUS up to its spawn only while a recent project-gate
  // verdict for its own directory exists (peekGateVerdict); on a miss it awaits
  // the gate. Warm it here rather than depending on whichever earlier test left
  // one cached, so the coalescing and mid-rotation cases below measure the
  // probe's own ordering and not a cache that expires after five seconds.
  await gateManagedLaunch(process.cwd())
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

  it('is a MANAGED launch: ambient authority is stripped and NO host-managed flag is set', async () => {
    // WP1.38. This path used to hand-build `{ ...process.env, USERPROFILE }`,
    // so it was the one managed launch with no hardening on it: an ambient
    // ANTHROPIC_API_KEY would have decided which account `claude auth status`
    // reported, under the profile home of a different one.
    //
    // The flag is asserted ABSENT (owner correction, 2026-09-22). Slice 2 first
    // set CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1 on every managed launch; gate A1
    // then measured that the CLI reads NO stored login under it, so re-adding it
    // here would make `claude auth status` report every managed account as signed
    // out -- which is the single loudest regression this file can catch.
    fs.mkdirSync(join(root, ID), { recursive: true })
    process.env.ANTHROPIC_API_KEY = 'sk-ambient-poison'
    process.env.CLAUDE_CONFIG_DIR = '/elsewhere'
    let seen: Record<string, string> | undefined
    try {
      execFileImpl = (_c, _a, o, cb) => {
        seen = (o as { env: Record<string, string> }).env
        cb(null, { stdout: JSON.stringify({ loggedIn: true }), stderr: '' })
      }
      await readClaudeCliAuth(ID)
    } finally {
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.CLAUDE_CONFIG_DIR
    }
    expect(seen?.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined()
    expect(seen?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(seen?.CLAUDE_CONFIG_DIR).toBeUndefined()
    // The realm it was pointed at is unchanged.
    expect(seen?.USERPROFILE).toBe(join(root, ID))
    expect(seen?.HOME).toBe(join(root, ID))
  })

  it('runs the project-settings gate for the directory it inherits, and passes the verdict in', async () => {
    // withProfileHome REFUSES a launch that names a working directory and
    // carries no gate verdict, so a probe that reached execFile at all must
    // have run the gate -- and the recorded verdict says which directory. A
    // probe that skipped the gate would fall through to the credential file
    // with the refusal swallowed, which is the silence this asserts against.
    fs.mkdirSync(join(root, ID), { recursive: true })
    _resetProjectScanStateForTest()   // undo the warm-up above: this case is the MISS
    expect(peekGateVerdict(process.cwd()), 'a verdict existed before the probe ran').toBeUndefined()
    let spawned = false
    execFileImpl = (_c, _a, _o, cb) => {
      spawned = true
      cb(null, { stdout: JSON.stringify({ loggedIn: true }), stderr: '' })
    }
    const r = await readClaudeCliAuth(ID)
    expect(spawned, 'the probe never reached the CLI, so it was refused').toBe(true)
    expect(r.source).toBe('cli-status')
    expect(peekGateVerdict(process.cwd()), 'the probe did not gate its own directory').toEqual({ status: 'clean' })
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
    // ...but already HELD (adversarial pass on #598): the hold is what stops a
    // NEW rotation from starting in the gap between this one settling and the spawn.
    expect(hasTransientProfileConsumer(ID)).toBe(true)

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
