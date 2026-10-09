// The Account usage page refreshes a lapsed access token (a single-use refresh
// token is spent and the new pair written back) only into a sign-in folder
// that has passed the app's owner-only check in this run: a folder refused,
// one not checked yet (just after start), or one replaced while the refresh
// was under way, gets no refresh and no write -- the credentials file stays
// exactly as it was. A folder that passed is refreshed as before.
//
// The real account-profiles module, with its owner-only rule replaced through
// the test seam; no process starts (child_process faked), the network is
// faked and every token is synthetic.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function fakeChildProcess(real: Record<string, unknown>) {
  const execFileSync = vi.fn((file: string, _a?: unknown, opts?: { encoding?: string }) => {
    if (/icacls/i.test(String(file))) return opts?.encoding ? '' : Buffer.alloc(0)
    throw new Error(`no process in this test: ${file}`)
  })
  const execFile = vi.fn((file: string, _a: unknown, _o: unknown, cb: (e: Error | null, o: string, eo: string) => void) => { cb(new Error(`no process in this test: ${file}`), '', '') })
  return { ...real, execFileSync, execFile, default: { ...real, execFileSync, execFile } }
}
vi.mock('node:child_process', async (importOriginal) => fakeChildProcess(await importOriginal()))
vi.mock('child_process', async (importOriginal) => fakeChildProcess(await importOriginal()))
vi.mock('../../src/main/claude-account-identity', () => ({
  isProfileInUseByLiveSession: () => false,
  getClaudeProfileId: () => undefined,
  getDefaultAccountEmail: () => null,
}))
vi.mock('../../src/main/usage/usage-snapshots', () => ({ loadSnapshots: () => new Map(), saveSnapshots: () => {} }))

const REFRESH = 'console.anthropic.com/v1/oauth/token'
const requests: string[] = []
/** Runs while the token refresh is answered (a test may change the folder then). */
let duringRefresh: () => void = () => {}
vi.mock('https', () => {
  const request = (opts: { hostname?: string; path?: string }, cb: (res: unknown) => void) => {
    const at = `${opts?.hostname}${opts?.path}`
    requests.push(at)
    const isRefresh = at === REFRESH
    const body = isRefresh
      ? JSON.stringify({ access_token: 'at-NEW', refresh_token: ['rt', 'NEW'].join('-'), expires_in: 3600 })
      : JSON.stringify({ five_hour: { utilization: 1, resets_at: null } })
    const res = {
      statusCode: 200, headers: {},
      on: (ev: string, fn: (arg?: unknown) => void) => { if (ev === 'data') fn(body); if (ev === 'end') fn(); return res },
    }
    queueMicrotask(() => { if (isRefresh) duringRefresh(); cb(res) })
    return { on: () => ({}), write: () => {}, end: () => {}, destroy: () => {}, setTimeout: () => {} }
  }
  return { default: { request }, request }
})

const ap = await import('../../src/main/account-profiles')
const { fetchAccountUsage } = await import('../../src/main/usage/account-usage')

const P = 'profile-mabc124-a1b2c4'
const PREFIX = 'ccc-usage-folder-verdict-'
const LAPSED = JSON.stringify({ claudeAiOauth: { accessToken: 'at-OLD', refreshToken: ['rt', 'OLD'].join('-'), expiresAt: 1 } })
let base = ''
let claudeDir = ''
let cred = ''

const passing = (dirs: readonly string[]) => dirs.map((dir) => {
  if (!fs.existsSync(dir) && fs.existsSync(path.dirname(dir))) fs.mkdirSync(dir)
  return { dir, ok: true, detail: 'owner-only' }
})

beforeEach(() => {
  requests.length = 0
  duringRefresh = () => {}
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)))
  const res = path.join(base, 'res')
  const shared = path.join(base, 'home', '.claude')
  fs.mkdirSync(res, { recursive: true })
  fs.mkdirSync(shared, { recursive: true })
  ap._setRootsForTest({ resourcesDir: res, sharedRoot: shared })
  ap._setCredentialFolderRuleForTest(null)
  const home = ap.getProfileConfigDir(P)
  claudeDir = path.join(home, '.claude')
  fs.mkdirSync(claudeDir, { recursive: true })
  cred = path.join(claudeDir, '.credentials.json')
  fs.writeFileSync(cred, LAPSED)
  // Not the primary account, active.
  ap.upsertProfile({ id: P, name: 'B', accountEmail: 'b@example.test', createdAt: 1 } as never)
})

afterEach(() => {
  ap._setCredentialFolderRuleForTest(null)
  ap._setRootsForTest(null)
  // TEST CLEANUP GUARD: this suite's own temp folder only.
  if (path.basename(base).startsWith(PREFIX)) fs.rmSync(base, { recursive: true, force: true })
})

describe('the usage page refreshes a sign-in only in a folder that passed the owner-only check', () => {
  it('a refused folder: no refresh is sent and the credentials file stays as it was', async () => {
    ap._setCredentialFolderRuleForTest(async (dirs) => dirs.map((dir) => ({ dir, ok: false, detail: 'its owner is not this user' })))
    await ap.checkProfileCredentialFolders(P)
    expect(ap.credentialFoldersVerdict([claudeDir]).ok).toBe(false)
    await fetchAccountUsage(P)
    expect(requests).not.toContain(REFRESH)
    expect(fs.readFileSync(cred, 'utf8')).toBe(LAPSED)
  })

  it('just after start, before the folder is checked: no refresh is sent and nothing is written', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const start = ap.startOwnerOnlyCredentialFolders(() => {}, async (dirs) => { await gate; return passing(dirs) })
    await fetchAccountUsage(P)
    expect(requests).not.toContain(REFRESH)
    expect(fs.readFileSync(cred, 'utf8')).toBe(LAPSED)
    release()
    await start
  })

  it('a folder replaced while the refresh was under way is not written into', async () => {
    ap._setCredentialFolderRuleForTest(async (dirs) => passing(dirs))
    await ap.checkProfileCredentialFolders(P)
    expect(ap.credentialFoldersVerdict([claudeDir]).ok).toBe(true)
    // Another real folder at its path: the old one moved aside first, so the
    // two exist at once and cannot share an identity.
    duringRefresh = () => {
      fs.renameSync(claudeDir, claudeDir + '.aside')
      fs.mkdirSync(claudeDir)
      fs.writeFileSync(cred, LAPSED)
    }
    await fetchAccountUsage(P)
    expect(requests).toContain(REFRESH)
    expect(fs.readFileSync(cred, 'utf8')).toBe(LAPSED)
  })

  it('a folder that passed: the lapsed token is refreshed and the new pair written', async () => {
    ap._setCredentialFolderRuleForTest(async (dirs) => passing(dirs))
    await ap.checkProfileCredentialFolders(P)
    const r = await fetchAccountUsage(P)
    expect(requests).toContain(REFRESH)
    const now = JSON.parse(fs.readFileSync(cred, 'utf8')) as { claudeAiOauth: { refreshToken: string; accessToken: string } }
    expect(now.claudeAiOauth.refreshToken).toBe(['rt', 'NEW'].join('-'))
    expect(now.claudeAiOauth.accessToken).toBe('at-NEW')
    expect(r.status).toBe('ok')
  })
})
