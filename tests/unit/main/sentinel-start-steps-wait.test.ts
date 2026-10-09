// Sentinel's Claude runs (its version check and its analysis) run on the
// analysis account, else the primary one, and, like a local launch, wait for
// what the app does at start before they read that account: the start's
// profile steps (they may still be making the primary account from the user's
// own sign-in) and the account's owner-only sign-in folder check. So a check
// asked for while those are under way neither runs on the bare global sign-in
// nor starts on an account whose folders have no verdict: it starts, on the
// primary account with its folders checked, once they are done.
//
// The REAL Sentinel service and the REAL account-profiles module (its
// owner-only rule replaced through the test seam and held on a gate). The
// headless runner is faked and records what it was asked, so nothing runs;
// the account resolver is a stand-in that picks the primary account without
// linking its shared folders (the real one's choice is
// account-profiles-headless-home.test.ts), so no link is made.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn() },
  app: { getPath: () => os.tmpdir() },
}))
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({
    // Claude Code on; the other assistant off, so only Claude's runs start.
    launchRefusal: (id: string) => (id === 'claude' ? null : { code: 'provider-off', providerId: id, message: 'That assistant is off.' }),
  }),
}))
const fakeChildProcess = vi.hoisted(() => (real: Record<string, unknown>) => {
  const execFileSync = vi.fn((file: string, _a?: unknown, opts?: { encoding?: string }) => {
    if (/icacls/i.test(String(file))) return opts?.encoding ? '' : Buffer.alloc(0)
    throw new Error(`no process in this test: ${file}`)
  })
  const execFile = vi.fn((file: string, _a: unknown, _o: unknown, cb: (e: Error | null, o: string, eo: string) => void) => { cb(new Error(`no process in this test: ${file}`), '', '') })
  const no = () => { throw new Error('no process in this test') }
  const spawn = vi.fn(no)
  const spawnSync = vi.fn(no)
  const execSync = vi.fn(no)
  return { ...real, execFileSync, execFile, spawn, spawnSync, execSync, default: { ...real, execFileSync, execFile, spawn, spawnSync, execSync } }
})
vi.mock('child_process', async (importOriginal) => fakeChildProcess(await importOriginal()))
vi.mock('node:child_process', async (importOriginal) => fakeChildProcess(await importOriginal()))
/** What each headless run saw as it started: its home, and whether that
 *  account's sign-in folders had their verdict then. */
const seen = vi.hoisted(() => ({ runs: [] as Array<{ args: string[]; home: string | null; checked: boolean | null }> }))
vi.mock('../../../src/main/claude-headless', () => ({
  spawnClaudeHeadless: async (args: string[], _t?: number, _stdin?: string, home: string | null = null) => {
    const ap = await import('../../../src/main/account-profiles')
    const id = home ? path.basename(home) : null
    seen.runs.push({ args, home, checked: id ? ap.profileCredentialFoldersChecked(id) : null })
    return { code: 0, stdout: '2.1.300 (Claude Code)', stderr: '' }
  },
}))
vi.mock('../../../src/main/sentinel/sentinel-model-article', () => ({ fetchArticleModelIds: async () => null }))
vi.mock('../../../src/main/sentinel/sentinel-changelog', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/sentinel/sentinel-changelog')>()),
  fetchChangelog: async () => null,
}))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => null, readConfigChecked: () => ({ value: null, outcome: 'absent' }) }))
vi.mock('../../../src/main/account-profiles', async (orig) => {
  const real = await orig<typeof import('../../../src/main/account-profiles')>()
  return {
    ...real,
    resolveHeadlessProfileHome: () => {
      const id = real.getPrimaryProfileId()
      return id ? { home: real.getProfileConfigDir(id), profileId: id } : { home: null, profileId: null }
    },
  }
})
vi.mock('../../../src/main/pty-manager', () => ({ resolveClaudeForPty: () => ({ cmd: 'claude' }) }))
vi.mock('../../../src/main/update-watcher', () => ({ getInstallPath: () => '', getProjectRootPath: () => '' }))
vi.mock('../../../src/main/claude-cli-probe', () => ({ probeClaudeCli: vi.fn() }))
vi.mock('../../../src/main/data-paths', () => ({
  getDataDirectory: () => os.tmpdir(), getResourcesDirectory: () => os.tmpdir(),
  setDataDirectory: vi.fn(), setResourcesDirectory: vi.fn(), isDataDirFromRegistry: () => true,
}))

const ap = await import('../../../src/main/account-profiles')

const P = 'profile-mabc127-a1b2c7'
const PREFIX = 'ccc-sentinel-start-wait-'
let base = ''
let dir = ''

/** The owner-only rule as the app's answers for folders it made owner-only,
 *  held until `release()`. */
function heldRule() {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const rule = async (dirs: readonly string[]) => {
    await gate
    return dirs.map((d) => {
      if (!fs.existsSync(d) && fs.existsSync(path.dirname(d))) fs.mkdirSync(d)
      return { dir: d, ok: true, detail: 'owner-only' }
    })
  }
  return { rule, release }
}

/** The primary account as the start's capture leaves it. */
function makePrimary(): void {
  const home = ap.getProfileConfigDir(P)
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 1 } }))
  ap.upsertProfile({ id: P, name: 'Primary', accountEmail: 'primary@example.test', createdAt: 1 } as never)
  ap.setPrimaryProfile(P)
}

async function sentinel() {
  const { _initRegistryForTest } = await import('../../../src/main/model-registry-service')
  _initRegistryForTest(dir)
  const mod = await import('../../../src/main/sentinel/index')
  mod.initSentinel(dir)
  return mod
}

const settle = () => new Promise((r) => setTimeout(r, 100))

beforeEach(() => {
  seen.runs.length = 0
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)))
  dir = path.join(base, 'sentinel')
  const res = path.join(base, 'res')
  const shared = path.join(base, 'home', '.claude')
  for (const d of [dir, res, shared]) fs.mkdirSync(d, { recursive: true })
  ap._setRootsForTest({ resourcesDir: res, sharedRoot: shared })
  ap._setCredentialFolderRuleForTest(null)
})

afterEach(() => {
  ap._setCredentialFolderRuleForTest(null)
  ap._setRootsForTest(null)
  // TEST CLEANUP GUARD: this suite's own temp folder only.
  if (path.basename(base).startsWith(PREFIX)) fs.rmSync(base, { recursive: true, force: true })
})

describe("Sentinel's Claude runs wait for the start, then run on the primary account with its folders checked", () => {
  it('first run: the start is still making the primary account, so the check waits and runs on it, never on the bare global sign-in', async () => {
    const s = await sentinel()
    const { rule, release } = heldRule()
    ap._setCredentialFolderRuleForTest(rule)
    const start = ap.startOwnerOnlyCredentialFolders(() => { makePrimary() }, rule)
    const p = s.sentinelRerun()
    await settle()
    expect(seen.runs).toHaveLength(0)
    release()
    await start
    await p
    expect(seen.runs[0]).toEqual({ args: ['--version'], home: ap.getProfileConfigDir(P), checked: true })
  })

  it('an upgrade: the primary account is there but its folders are still being checked at start, so the check waits and starts with a verdict', async () => {
    makePrimary()
    const s = await sentinel()
    const { rule, release } = heldRule()
    ap._setCredentialFolderRuleForTest(rule)
    const start = ap.startOwnerOnlyCredentialFolders(() => {}, rule)
    const p = s.sentinelRerun()
    await settle()
    expect(seen.runs).toHaveLength(0)
    release()
    await start
    await p
    expect(seen.runs[0]).toEqual({ args: ['--version'], home: ap.getProfileConfigDir(P), checked: true })
  })

  it('no start pending, the account\'s folders not checked yet: the check waits for their verdict, then starts', async () => {
    makePrimary()
    const s = await sentinel()
    const { rule, release } = heldRule()
    ap._setCredentialFolderRuleForTest(rule)
    expect(ap.startProfileStepsPending()).toBe(false)
    expect(ap.profileCredentialFoldersChecked(P)).toBe(false)
    const p = s.sentinelRerun()
    await settle()
    expect(seen.runs).toHaveLength(0)
    release()
    await p
    expect(seen.runs[0]).toEqual({ args: ['--version'], home: ap.getProfileConfigDir(P), checked: true })
  })
})
