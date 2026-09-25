/**
 * WP2: the two remaining ways main starts Claude Code on its own account are
 * refused while Claude Code is off, through the one launch rule:
 *
 *  - Sentinel: a user's Re-run (a `claude --version` probe, then an analysis
 *    that is a `claude -p` run) is refused with the reason in the panel; the
 *    automatic start-up check runs its CLI-free model-coverage check and then
 *    starts no Claude at all (no probe runs unasked for a provider that is
 *    off).
 *  - The first-run CLI setup terminal, which runs Claude Code itself (its
 *    folder-trust prompt): refused before any PTY is spawned, answered so the
 *    setup terminal says why.
 *
 * The REAL Sentinel service, the REAL setup handler and the REAL launch gate;
 * the accounts service's answer is scripted (its rule is proven against real
 * settings in provider-launch-gate.test.ts), and the headless spawner and
 * node-pty are faked, so nothing runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: vi.fn() },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn() },
  app: { getPath: () => os.tmpdir() },
}))
const acct = vi.hoisted(() => ({ claude: 'on' as 'on' | 'off' | 'unreadable' }))
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({
    launchRefusal: (id: string) => id !== 'claude' || acct.claude === 'on' ? null
      : acct.claude === 'off' ? { code: 'provider-off', providerId: 'claude', message: 'Claude Code is off. Turn it on in Settings, Accounts.' }
      : { code: 'provider-state-unknown', providerId: 'claude', message: 'This app could not read whether Claude Code is on. Check Settings, Accounts.' },
  }),
}))
const hold = vi.hoisted(() => ({ headless: null as null | Promise<void> }))
const spawnClaudeHeadless = vi.fn(async (_args: string[]) => {
  if (hold.headless) await hold.headless
  return { code: 0, stdout: '2.1.300 (Claude Code)', stderr: '' }
})
vi.mock('../../../src/main/claude-headless', () => ({ spawnClaudeHeadless: (...a: unknown[]) => spawnClaudeHeadless(...(a as [string[]])) }))
const fetchArticleModelIds = vi.fn(async () => null)
vi.mock('../../../src/main/sentinel/sentinel-model-article', () => ({ fetchArticleModelIds: () => fetchArticleModelIds() }))
const fetchChangelog = vi.fn(async () => null)
vi.mock('../../../src/main/sentinel/sentinel-changelog', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/sentinel/sentinel-changelog')>()),
  fetchChangelog: () => fetchChangelog(),
}))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => null, readConfigChecked: () => ({ value: null, outcome: 'absent' }) }))
vi.mock('../../../src/main/account-profiles', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/account-profiles')>()),
  resolveHeadlessProfileHome: () => ({ home: null, profileId: null }),
  listProfiles: () => [],
}))
// The CLI setup terminal.
const ptySpawn = vi.fn(() => ({ onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn() }))
vi.mock('node-pty', () => ({ spawn: (...a: unknown[]) => ptySpawn(...(a as [])) }))
vi.mock('../../../src/main/pty-manager', () => ({ resolveClaudeForPty: () => ({ cmd: 'claude' }) }))
vi.mock('../../../src/main/update-watcher', () => ({ getInstallPath: () => '', getProjectRootPath: () => '' }))
vi.mock('../../../src/main/claude-cli-probe', () => ({ probeClaudeCli: vi.fn() }))
vi.mock('../../../src/main/data-paths', () => ({
  getDataDirectory: () => os.tmpdir(), getResourcesDirectory: () => os.tmpdir(),
  setDataDirectory: vi.fn(), setResourcesDirectory: vi.fn(), isDataDirFromRegistry: () => true,
}))

const OFF_TEXT = 'Claude Code is off. Turn it on in Settings, Accounts.'
let dir = ''
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-sentinel-off-'))
  acct.claude = 'on'
  spawnClaudeHeadless.mockClear()
  hold.headless = null
  fetchArticleModelIds.mockClear()
  fetchChangelog.mockClear()
  ptySpawn.mockClear()
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

async function sentinel() {
  const { _initRegistryForTest } = await import('../../../src/main/model-registry-service')
  _initRegistryForTest(dir)
  const mod = await import('../../../src/main/sentinel/index')
  mod.initSentinel(dir)
  return mod
}

describe('Sentinel while Claude Code is off', () => {
  it("a user's Re-run: refused, the panel says why, and no Claude process starts", async () => {
    const s = await sentinel()
    acct.claude = 'off'
    await s.sentinelRerun()
    expect(spawnClaudeHeadless).not.toHaveBeenCalled()
    expect(s.getSentinelState()!.snapshot()).toMatchObject({ analyzing: false, lastAnalysisError: OFF_TEXT })
  })

  it('the start-up check runs its model-coverage check and starts no Claude (not even the version probe)', async () => {
    const s = await sentinel()
    acct.claude = 'off'
    await s.sentinelStartupCheck()
    expect(fetchArticleModelIds).toHaveBeenCalledTimes(1)
    expect(spawnClaudeHeadless).not.toHaveBeenCalled()
  })

  it('a setting that cannot be read refuses the Re-run too (fail closed)', async () => {
    const s = await sentinel()
    acct.claude = 'unreadable'
    await s.sentinelRerun()
    expect(spawnClaudeHeadless).not.toHaveBeenCalled()
    expect(s.getSentinelState()!.snapshot().lastAnalysisError).toBe('This app could not read whether Claude Code is on. Check Settings, Accounts.')
  })

  it('switched off while the changelog is fetched: the analysis (a claude -p run) is not started, and the panel says why', async () => {
    const s = await sentinel()
    fetchChangelog.mockImplementationOnce(async () => { acct.claude = 'off'; return '## 2.1.300\n- a change\n' })
    await s.sentinelRerun()
    // The version probe ran (Claude Code was on); the analysis did not.
    expect(spawnClaudeHeadless).toHaveBeenCalledTimes(1)
    expect(spawnClaudeHeadless.mock.calls[0][0]).toEqual(['--version'])
    expect(s.getSentinelState()!.snapshot()).toMatchObject({ analyzing: false, lastAnalysisError: OFF_TEXT })
  })

  it('with Claude Code on, the Re-run probes the CLI as before', async () => {
    const s = await sentinel()
    await s.sentinelRerun()
    expect(spawnClaudeHeadless).toHaveBeenCalledWith(['--version'], 15000, undefined, null)
  })
})

describe("Sentinel's Claude runs are Claude Code in use while they run", () => {
  it('a Re-run: counted from the launch check to the end, then not', async () => {
    const s = await sentinel()
    let release!: () => void
    hold.headless = new Promise<void>((r) => { release = r })
    expect(s.sentinelClaudeRunsInFlight()).toBe(0)
    const pending = s.sentinelRerun()
    await new Promise<void>((r) => setTimeout(r, 0))
    expect(spawnClaudeHeadless).toHaveBeenCalledTimes(1)
    expect(s.sentinelClaudeRunsInFlight()).toBe(1)
    release()
    await pending
    expect(s.sentinelClaudeRunsInFlight()).toBe(0)
  })

  it('the start-up check: counted too, then not', async () => {
    const s = await sentinel()
    let release!: () => void
    hold.headless = new Promise<void>((r) => { release = r })
    const pending = s.sentinelStartupCheck()
    for (let i = 0; i < 5 && spawnClaudeHeadless.mock.calls.length === 0; i++) await new Promise<void>((r) => setTimeout(r, 0))
    expect(s.sentinelClaudeRunsInFlight()).toBe(1)
    release()
    await pending
    expect(s.sentinelClaudeRunsInFlight()).toBe(0)
  })

  it('a refused run is not counted', async () => {
    const s = await sentinel()
    acct.claude = 'off'
    await s.sentinelRerun()
    expect(s.sentinelClaudeRunsInFlight()).toBe(0)
  })
})

describe('the first-run CLI setup terminal runs Claude Code', () => {
  const setupHandler = async () => {
    const real = await vi.importActual<typeof import('../../../src/main/ipc/setup-handlers')>('../../../src/main/ipc/setup-handlers')
    real.registerSetupHandlers()
    return handlers.get('setup:spawnCliSetup')!
  }

  it('refused while Claude Code is off: no PTY, and the answer says why', async () => {
    const h = await setupHandler()
    acct.claude = 'off'
    await expect(h({ sender: {} }, 100, 20)).resolves.toEqual({ refused: { code: 'provider-off', providerId: 'claude', message: OFF_TEXT } })
    expect(ptySpawn).not.toHaveBeenCalled()
  })

  it('the terminal is Claude Code in use while it is open: counted from its start, not once it exits, never when refused', async () => {
    const real = await vi.importActual<typeof import('../../../src/main/ipc/setup-handlers')>('../../../src/main/ipc/setup-handlers')
    const h = await setupHandler()
    acct.claude = 'off'
    await h({ sender: {} }, 100, 20)
    expect(real.countCliSetupInUse()).toBe(0)
    acct.claude = 'on'
    await h({ sender: {} }, 100, 20)
    expect(real.countCliSetupInUse()).toBe(1)
    // The terminal exits.
    const term = ptySpawn.mock.results.at(-1)!.value as { onExit: ReturnType<typeof vi.fn> }
    const onExit = term.onExit.mock.calls[0][0] as (e: { exitCode: number }) => void
    onExit({ exitCode: 0 })
    expect(real.countCliSetupInUse()).toBe(0)
  })

  it('with Claude Code on, the terminal starts as before', async () => {
    const h = await setupHandler()
    await expect(h({ sender: {} }, 100, 20)).resolves.toBe('__cli_setup__')
    expect(ptySpawn).toHaveBeenCalledTimes(1)
  })
})
