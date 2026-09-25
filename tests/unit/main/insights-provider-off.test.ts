/**
 * WP2: an insights run is a Claude Code run -- the interactive /insights PTY,
 * the KPI extraction and, for a cross-account roll-up, the synthesis -- so
 * main refuses one while Claude Code is off (runInsights and
 * runCrossAccountInsights, the layer both IPC handlers call), BEFORE a run
 * record or a lock exists. The refusal is an answer the Insights page shows,
 * never a throw. A run that is already going asks again before each later
 * Claude step, so a switch-off mid-run stops it there instead of starting
 * another Claude process.
 *
 * The REAL insights runner and the REAL launch gate; the accounts service's
 * answer is scripted (its rule is proven against real settings in
 * provider-launch-gate.test.ts), and node-pty and the headless spawner are
 * faked, so nothing runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const h = vi.hoisted(() => ({
  resourcesDir: '',
  profileDir: {} as Record<string, string>,
  profiles: [] as Array<{ id: string; accountEmail: string; isPrimary?: boolean }>,
  claude: 'on' as 'on' | 'off' | 'unreadable',
  /** Switch Claude Code off when this step starts (a switch-off mid-run). */
  offAt: null as null | 'refresh-wait' | 'pty-exit' | 'last-kpi',
  /** When set, the /insights PTY exits only once this settles. */
  ptyHold: null as null | Promise<void>,
  kpiCalls: 0,
  synthesisCalls: 0,
}))

vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => h.resourcesDir, registerSetupHandlers: () => {} }))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  getProfileConfigDir: (id: string) => h.profileDir[id] ?? '',
  getPrimaryProfileId: () => h.profiles.find((p) => p.isPrimary)?.id ?? null,
  setupProfileLinks: () => {},
  listProfiles: () => h.profiles,
}))
vi.mock('../../../src/main/update-watcher', () => ({ getInstallPath: () => '', getProjectRootPath: () => '' }))
// A run on an account holds it, then waits out any sign-in refresh in flight
// before its first Claude step: a switch-off can land in that wait.
vi.mock('../../../src/main/profile-consumers', () => ({
  acquireProfileConsumer: () => () => {},
  waitForProfileRefresh: async () => { if (h.offAt === 'refresh-wait') h.claude = 'off' },
}))
vi.mock('../../../src/main/pty-manager', () => ({ resolveClaudeForPty: () => ({ cmd: 'claude' }), withProfileHome: (env: unknown) => env }))
const ptySpawn = vi.fn(() => ({
  onData: () => {},
  onExit: (cb: (e: { exitCode: number }) => void) => {
    const exit = () => { if (h.offAt === 'pty-exit') h.claude = 'off'; cb({ exitCode: 0 }) }
    if (h.ptyHold) void h.ptyHold.then(exit)
    else exit()
  },
  write: () => {},
  kill: () => {},
}))
vi.mock('node-pty', () => ({ spawn: (...a: unknown[]) => ptySpawn(...(a as [])) }))
const KPIS = JSON.stringify({
  period: { start: '2026-07-01', end: '2026-07-31', days: 31 },
  kpis: { Volume: { sessions: { value: 10, label: 'Sessions', format: 'number', goodDirection: 'up' } } },
})
vi.mock('../../../src/main/claude-headless', () => ({
  spawnClaudeHeadless: async (args: string[]) => {
    if (args.includes('--allowedTools')) {
      h.kpiCalls++
      if (h.offAt === 'last-kpi' && h.kpiCalls === h.profiles.length) h.claude = 'off'
      return { code: 0, stdout: KPIS, stderr: '' }
    }
    h.synthesisCalls++
    return { code: 0, stdout: JSON.stringify({ summary: { improvements: ['steady'] }, accounts: [], crossAccount: { observations: [] } }), stderr: '' }
  },
}))
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({
    launchRefusal: (id: string) => id !== 'claude' || h.claude === 'on' ? null
      : h.claude === 'off' ? { code: 'provider-off', providerId: 'claude', message: 'Claude Code is off. Turn it on in Settings, Accounts.' }
      : { code: 'provider-state-unknown', providerId: 'claude', message: 'This app could not read whether Claude Code is on. Check Settings, Accounts.' },
  }),
}))

const { runInsights, runCrossAccountInsights, getCatalogue, isRunning, isCrossAccountRunning, countInsightsRunsInFlight } = await import('../../../src/main/insights-runner')
const OFF = { refused: { code: 'provider-off', providerId: 'claude', message: 'Claude Code is off. Turn it on in Settings, Accounts.' } }
const win = () => null
let tmpRoot = ''

function seed(id: string, isPrimary = false): void {
  const dir = join(tmpRoot, 'profiles', id)
  mkdirSync(join(dir, '.claude', 'usage-data'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'usage-data', 'report.html'), '<html>report</html>')
  h.profileDir[id] = dir
  h.profiles.push({ id, accountEmail: `${id}@example.com`, isPrimary })
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'insights-off-'))
  h.resourcesDir = join(tmpRoot, 'resources')
  mkdirSync(h.resourcesDir, { recursive: true })
  h.profileDir = {}
  h.profiles = []
  h.claude = 'on'
  h.offAt = null
  h.ptyHold = null
  h.kpiCalls = 0
  h.synthesisCalls = 0
  ptySpawn.mockClear()
  seed('a', true)
  seed('b')
})
afterEach(() => { try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ } })

describe('an insights run while Claude Code is off', () => {
  it('one account: refused with the typed refusal; no run, no lock, no Claude process', async () => {
    h.claude = 'off'
    await expect(runInsights(win, { profileId: 'a' })).resolves.toEqual(OFF)
    expect(ptySpawn).not.toHaveBeenCalled()
    expect(h.kpiCalls).toBe(0)
    expect(getCatalogue().runs).toEqual([])
    expect(isRunning()).toBe(false)
  })

  it('the cross-account roll-up: refused the same way, before any member runs', async () => {
    h.claude = 'off'
    await expect(runCrossAccountInsights(win)).resolves.toEqual(OFF)
    expect(ptySpawn).not.toHaveBeenCalled()
    expect(getCatalogue().runs).toEqual([])
    expect(isCrossAccountRunning()).toBe(false)
  })

  it('a setting that cannot be read refuses both (fail closed)', async () => {
    h.claude = 'unreadable'
    const one = await runInsights(win, { profileId: 'a' }) as { refused: { code: string } }
    const all = await runCrossAccountInsights(win) as { refused: { code: string } }
    expect([one.refused.code, all.refused.code]).toEqual(['provider-state-unknown', 'provider-state-unknown'])
    expect(ptySpawn).not.toHaveBeenCalled()
  })

  it('with Claude Code on, a run goes ahead as before', async () => {
    const id = await runInsights(win, { profileId: 'a' })
    expect(typeof id).toBe('string')
    expect(ptySpawn).toHaveBeenCalledTimes(1)
    expect(getCatalogue().runs.find((r) => r.id === id)?.status).toBe('complete')
  })
})

describe('switched off while a run is going: the next Claude step is not started', () => {
  it('during the wait before the report: the /insights PTY is not started, and the run says why', async () => {
    h.offAt = 'refresh-wait'
    const id = await runInsights(win, { profileId: 'a' }) as string
    expect(ptySpawn).not.toHaveBeenCalled()
    expect(getCatalogue().runs.find((r) => r.id === id)).toMatchObject({ status: 'failed', error: 'Claude Code is off. Turn it on in Settings, Accounts.' })
    expect(isRunning()).toBe(false)
  })

  it('after the report, the KPI extraction is refused: the report stays, the KPIs say why', async () => {
    h.offAt = 'pty-exit'
    const id = await runInsights(win, { profileId: 'a' }) as string
    expect(h.kpiCalls).toBe(0)
    const run = getCatalogue().runs.find((r) => r.id === id)!
    expect(run).toMatchObject({ status: 'complete', kpisUnavailable: true, error: 'Claude Code is off. Turn it on in Settings, Accounts.' })
  })

  it('a roll-up switched off mid fan-out: a member not yet started is refused, and says why', async () => {
    seed('c')
    // Members run two at a time: a and b start, a's report ends and Claude
    // Code is switched off, so c -- started only after that -- never runs.
    h.offAt = 'pty-exit'
    const id = await runCrossAccountInsights(win) as string
    const agg = getCatalogue().runs.find((r) => r.id === id)!
    expect(agg.members!.find((m) => m.profileId === 'c')).toMatchObject({ status: 'failed', error: 'Claude Code is off. Turn it on in Settings, Accounts.' })
    // c never started its /insights PTY (a's and b's had).
    expect(ptySpawn.mock.calls.length).toBeLessThan(3)
    expect(h.synthesisCalls).toBe(0)
  })

  it('a roll-up whose members finished: the synthesis is refused, numbers only, and it says why', async () => {
    h.offAt = 'last-kpi'
    const id = await runCrossAccountInsights(win) as string
    expect(h.synthesisCalls).toBe(0)
    const agg = getCatalogue().runs.find((r) => r.id === id)!
    expect(agg.status).toBe('complete')
    expect(agg.error).toBe('No written analysis. Claude Code is off. Turn it on in Settings, Accounts.')
    expect(agg.authFailed).toBeFalsy()
  })
})

describe('an insights run is Claude Code in use while it runs', () => {
  it('one account: counted from the launch check to the end, then not', async () => {
    let release!: () => void
    h.ptyHold = new Promise<void>((r) => { release = r })
    expect(countInsightsRunsInFlight()).toBe(0)
    const pending = runInsights(win, { profileId: 'a' })
    // Counted in the same step as the check: before any await.
    expect(countInsightsRunsInFlight()).toBe(1)
    await new Promise<void>((r) => setTimeout(r, 0))
    expect(countInsightsRunsInFlight()).toBe(1)
    release()
    await pending
    expect(countInsightsRunsInFlight()).toBe(0)
  })

  it('a cross-account roll-up: counted too, then not', async () => {
    let release!: () => void
    h.ptyHold = new Promise<void>((r) => { release = r })
    const pending = runCrossAccountInsights(win)
    expect(countInsightsRunsInFlight()).toBeGreaterThanOrEqual(1)
    release()
    await pending
    expect(countInsightsRunsInFlight()).toBe(0)
  })

  it('a refused run is not counted', async () => {
    h.claude = 'off'
    await runInsights(win, { profileId: 'a' })
    expect(countInsightsRunsInFlight()).toBe(0)
  })
})
