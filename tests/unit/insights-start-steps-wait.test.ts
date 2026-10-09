// An Insights run that names no account runs on the primary one, and, like a
// local launch, waits for what the app does at start before it reads that
// account: the start's profile steps (they may still be making the primary
// account from the user's own sign-in) and the account's owner-only sign-in
// folder check. So a run asked for while those are under way neither runs on
// the bare global sign-in nor is refused for want of a verdict: its terminal
// starts, on the primary account, once they are done. An account whose
// folders have no verdict yet (none pending at start) is checked first in the
// same way.
//
// The REAL account-profiles module (its owner-only rule replaced through the
// test seam and held on a gate; setupProfileLinks stubbed, so no link is
// made) and the real launch environment; the terminal and every process are
// faked, so nothing runs. Synthetic sign-ins only.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => null, providerProbeRefusal: () => null }))
const h = vi.hoisted(() => ({
  resourcesDir: '',
  spawns: [] as Array<{ env: Record<string, string> }>,
  exits: [] as Array<(e: { exitCode: number }) => void>,
  /** A terminal ends as soon as it starts (the roll-up's member runs). */
  autoExit: false,
  /** What a member run's KPI read answers; null: it fails, as before. */
  kpiStdout: null as string | null,
  /** Called on each member run's KPI read, with the count so far. */
  onKpiRead: null as null | ((n: number) => void),
  kpiReads: 0,
  /** The homes the roll-up's written analysis was started under. */
  synthesisHomes: [] as Array<string | null>,
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
vi.mock('../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => h.resourcesDir,
  registerSetupHandlers: () => {},
}))
// The account's shared folders are linked by setupProfileLinks: stubbed, so
// this suite makes no link or junction.
vi.mock('../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/account-profiles')>()),
  setupProfileLinks: () => {},
}))
vi.mock('../../src/main/update-watcher', () => ({ getInstallPath: () => '', getProjectRootPath: () => '' }))
// The launch environment is the real one (account-profiles' withProfileHome,
// which refuses an account whose sign-in folders have no passing verdict).
vi.mock('../../src/main/pty-manager', async () => {
  const ap = await import('../../src/main/account-profiles')
  return { resolveClaudeForPty: () => ({ cmd: 'claude' }), withProfileHome: ap.withProfileHome }
})
vi.mock('node-pty', () => ({
  spawn: (_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
    h.spawns.push({ env: opts.env })
    return {
      onData: () => {},
      onExit: (cb: (e: { exitCode: number }) => void) => { if (h.autoExit) cb({ exitCode: 0 }); else h.exits.push(cb) },
      write: () => {},
      kill: () => {},
      on: () => {},
    }
  },
}))
vi.mock('../../src/main/claude-headless', () => ({
  spawnClaudeHeadless: async (args: string[], _timeout?: number, _prompt?: string, home?: string | null) => {
    if (args.includes('--allowedTools')) {
      h.onKpiRead?.(++h.kpiReads)
      return h.kpiStdout === null ? { code: 1, stdout: '', stderr: 'not in this test' } : { code: 0, stdout: h.kpiStdout, stderr: '' }
    }
    h.synthesisHomes.push(home ?? null)
    return { code: 1, stdout: '', stderr: 'no written analysis in this test' }
  },
}))

import { composeProviders } from '../../src/main/providers/compose'
const ap = await import('../../src/main/account-profiles')
const { runInsights, isRunning, runCrossAccountInsights, isCrossAccountRunning, getCatalogue } = await import('../../src/main/insights-runner')

const P = 'profile-mabc126-a1b2c6'
const PREFIX = 'ccc-insights-start-wait-'
let base = ''
const getWin = () => null

/** The owner-only rule as the app's answers for folders it made owner-only,
 *  held until `release()`. */
function heldRule() {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const rule = async (dirs: readonly string[]) => {
    await gate
    return dirs.map((dir) => {
      if (!fs.existsSync(dir) && fs.existsSync(path.dirname(dir))) fs.mkdirSync(dir)
      return { dir, ok: true, detail: 'owner-only' }
    })
  }
  return { rule, release }
}

/** The primary account as the start's capture leaves it: real folders, a
 *  synthetic sign-in, the account listed and marked primary. */
function makePrimary(): void {
  const home = ap.getProfileConfigDir(P)
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 1 } }))
  ap.upsertProfile({ id: P, name: 'Primary', accountEmail: 'primary@example.test', createdAt: 1 } as never)
  ap.setPrimaryProfile(P)
}

const settle = () => new Promise((r) => setTimeout(r, 100))
const until = async (cond: () => boolean, why: string) => {
  const deadline = Date.now() + 5000
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
  if (!cond()) throw new Error(`timed out waiting for ${why}`)
}
/** The run's terminal ends, so the run settles (it finds no report: failed). */
async function endRun(p: Promise<unknown>): Promise<void> {
  for (const exit of h.exits.splice(0)) exit({ exitCode: 0 })
  await p.catch(() => {})
}

beforeAll(() => { composeProviders() })

beforeEach(() => {
  h.spawns.length = 0
  h.exits.length = 0
  h.autoExit = false
  h.kpiStdout = null
  h.onKpiRead = null
  h.kpiReads = 0
  h.synthesisHomes.length = 0
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)))
  const res = path.join(base, 'res')
  const shared = path.join(base, 'home', '.claude')
  for (const d of [res, shared]) fs.mkdirSync(d, { recursive: true })
  h.resourcesDir = res
  ap._setRootsForTest({ resourcesDir: res, sharedRoot: shared })
  ap._setCredentialFolderRuleForTest(null)
})

afterEach(() => {
  ap._setCredentialFolderRuleForTest(null)
  ap._setRootsForTest(null)
  // TEST CLEANUP GUARD: this suite's own temp folder only.
  if (path.basename(base).startsWith(PREFIX)) fs.rmSync(base, { recursive: true, force: true })
})

describe('an Insights run that names no account waits for the start, then runs on the primary account', () => {
  it('first run: the start is still making the primary account, so the run waits and its terminal starts on it, never on the bare global sign-in', async () => {
    const { rule, release } = heldRule()
    ap._setCredentialFolderRuleForTest(rule)
    const start = ap.startOwnerOnlyCredentialFolders(() => { makePrimary() }, rule)
    const p = runInsights(getWin)
    await settle()
    expect(h.spawns).toHaveLength(0)
    expect(isRunning()).toBe(false)
    release()
    await start
    await until(() => h.spawns.length === 1, 'the terminal to start')
    expect(h.spawns[0].env.USERPROFILE).toBe(ap.getProfileConfigDir(P))
    await endRun(p)
  })

  it('an upgrade: the primary account is there but its folders are still being checked at start, so the run waits and starts, never refused', async () => {
    makePrimary()
    const { rule, release } = heldRule()
    ap._setCredentialFolderRuleForTest(rule)
    const start = ap.startOwnerOnlyCredentialFolders(() => {}, rule)
    const p = runInsights(getWin)
    await settle()
    expect(h.spawns).toHaveLength(0)
    release()
    await start
    await until(() => h.spawns.length === 1, 'the terminal to start')
    expect(h.spawns[0].env.USERPROFILE).toBe(ap.getProfileConfigDir(P))
    await endRun(p)
  })

  it('no start pending, the account\'s folders not checked yet: the run waits for their check, then starts', async () => {
    makePrimary()
    const { rule, release } = heldRule()
    ap._setCredentialFolderRuleForTest(rule)
    expect(ap.startProfileStepsPending()).toBe(false)
    expect(ap.profileCredentialFoldersChecked(P)).toBe(false)
    const p = runInsights(getWin)
    await settle()
    expect(h.spawns).toHaveLength(0)
    release()
    await until(() => h.spawns.length === 1, 'the terminal to start')
    expect(h.spawns[0].env.USERPROFILE).toBe(ap.getProfileConfigDir(P))
    await endRun(p)
  })
})

describe('a cross-account summary waits for the check of the account its written analysis runs on', () => {
  const Q = 'profile-mabc127-a1b2c7'
  const KPIS = JSON.stringify({
    period: { start: '2026-07-01', end: '2026-07-31', days: 31 },
    kpis: { Volume: { sessions: { value: 10, label: 'Sessions', format: 'number', goodDirection: 'up' } } },
  })

  /** An account with real folders, a synthetic sign-in and a report its run archives. */
  function makeAccount(id: string, email: string): void {
    const home = ap.getProfileConfigDir(id)
    fs.mkdirSync(path.join(home, '.claude', 'usage-data'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `at-${id}`, refreshToken: `rt-${id}`, expiresAt: Date.now() + 3_600_000 } }))
    fs.writeFileSync(path.join(home, '.claude', 'usage-data', 'report.html'), '<html><body>report</body></html>')
    ap.upsertProfile({ id, name: email, accountEmail: email, createdAt: 1 } as never)
  }

  it('the members ran on checked folders; the analysis account\'s check is gone by the summary, so the summary waits for it, then runs on that account', async () => {
    makeAccount(P, 'primary@example.test')
    makeAccount(Q, 'second@example.test')
    ap.setPrimaryProfile(P)
    // The members' folders pass at once.
    ap._setCredentialFolderRuleForTest(async (dirs) => dirs.map((dir) => ({ dir, ok: true, detail: 'owner-only' })))
    h.autoExit = true
    h.kpiStdout = KPIS
    // Once both members have read their figures, the app forgets every
    // verdict and the next check is held: the summary's account has none.
    const { rule, release } = heldRule()
    h.onKpiRead = (n) => { if (n === 2) ap._setCredentialFolderRuleForTest(rule) }
    const p = runCrossAccountInsights(getWin)
    await until(() => h.kpiReads === 2, 'both members to read their figures')
    await settle()
    expect(ap.profileCredentialFoldersChecked(P)).toBe(false)
    expect(h.synthesisHomes).toEqual([])
    expect(isCrossAccountRunning()).toBe(true)
    release()
    await until(() => h.synthesisHomes.length === 1, 'the written analysis to start')
    expect(h.synthesisHomes).toEqual([ap.getProfileConfigDir(P)])
    const id = await p
    expect(ap.profileCredentialFoldersChecked(P)).toBe(true)
    const run = getCatalogue().runs.find((r) => r.id === id)
    expect(run?.kind).toBe('aggregate')
    expect(run?.status).toBe('complete')
    expect(run?.members?.map((m) => m.status)).toEqual(['complete', 'complete'])
  })
})
