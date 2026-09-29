/**
 * P3.9 (rows 39, 42): Sentinel for Codex, through the REAL Sentinel service.
 *
 *  - While Codex is on, the start-up check and a Re-run check the installed
 *    Codex's version against the supported range, compare the model registry
 *    with the list that CLI offers (the live read), and analyse Codex's
 *    release notes when its version changed since the last check. While it
 *    is off or not set up, nothing of it runs and nothing about it is said.
 *  - The analysis runs on the provider that is on: with both on, the one Ask
 *    Conductor runs on (Claude Code by default); Codex only, on Codex, as a
 *    prepared reviewer launch in a fresh empty folder that is removed after.
 *  - Sentinel's Codex runs count as Codex in use while they run.
 *
 * The accounts service, the Codex package's reviewer, the headless Claude
 * spawner, the network fetches and the settings are faked: no process
 * starts, no request leaves, and the only folders made are this suite's own
 * state folder and the analysis folder the service makes (and removes) under
 * the temp folder.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  app: { getPath: () => os.tmpdir() },
}))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn() }))

type Pref = 'on' | 'off' | 'undecided'
const svc = vi.hoisted(() => ({
  pref: { claude: 'on', codex: 'on' } as Record<string, 'on' | 'off' | 'undecided'>,
  installation: { discoveryState: 'found', version: '0.155.1', compatibility: 'supported' } as Record<string, unknown>,
  catalogue: null as null | Record<string, unknown>,
  discovers: 0,
  catalogueReads: 0,
  holdDiscover: null as null | Promise<void>,
  prepares: [] as Array<Record<string, unknown>>,
  prepareAnswer: null as null | ((input: Record<string, unknown>) => Record<string, unknown> | null),
  released: 0,
}))
const review = vi.hoisted(() => ({
  runs: [] as Array<{ executable: string; env: Record<string, string>; cwd: string; prompt: string; timeoutMs: number; cwdExisted: boolean }>,
  answer: null as null | (() => Record<string, unknown>),
  hold: null as null | Promise<void>,
}))
const refusal = (id: string) => {
  const p = svc.pref[id]
  const name = id === 'codex' ? 'Codex' : 'Claude Code'
  if (p === 'off') return { code: 'provider-off', providerId: id, message: `${name} is off. Turn it on in Settings, Accounts.` }
  if (p === 'undecided') return { code: 'provider-not-set-up', providerId: id, message: `${name} is not set up.` }
  return null
}
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({
    launchRefusal: (id: string) => refusal(id),
    discover: async (id: string) => {
      svc.discovers++
      if (svc.holdDiscover) await svc.holdDiscover
      if (refusal(id)) return { ok: false, code: 'provider-disabled', message: 'off' }
      return { ok: true, installation: { providerId: id, ...svc.installation } }
    },
    readModelCatalogue: async (id: string) => {
      svc.catalogueReads++
      if (refusal(id)) return { ok: false, code: 'provider-disabled', message: 'off' }
      return { ok: true, catalogue: svc.catalogue ?? { ok: false, code: 'failed', detail: 'x' } }
    },
    prepareLaunch: async (input: Record<string, unknown>) => {
      svc.prepares.push(input)
      const a = svc.prepareAnswer ? svc.prepareAnswer(input) : null
      if (a) return a
      return {
        ok: true, lease: { release: () => { svc.released++ } }, binding: { providerAccountId: 'acct-work', authRealmId: 'realm-1' }, realmOnly: false,
        home: 'C:\\realms\\realm-1', executable: 'C:\\Tools\\codex.exe', env: { CODEX_HOME: 'C:\\realms\\realm-1' }, sessionsDir: 'C:\\realms\\realm-1\\sessions',
      }
    },
    snapshot: () => ({ accounts: [{ id: 'acct-work', identityId: 'id-1', providerLabel: 'work@example.com' }], identities: [{ id: 'id-1', friendlyName: 'Work' }] }),
  }),
}))
vi.mock('../../../src/main/providers/core', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/providers/core')>()),
  tryGetProviderPackage: (id: string) => id !== 'codex' ? null : {
    id, displayName: 'Codex',
    setup: { supportedVersions: { minimum: '0.153.4', maximumTested: '0.156.1' } },
    review: {
      run: async (input: { executable: string; env: Record<string, string>; cwd: string; prompt: string; timeoutMs: number }) => {
        review.runs.push({ ...input, cwdExisted: fs.existsSync(input.cwd) && fs.readdirSync(input.cwd).length === 0 })
        if (review.hold) await review.hold
        return review.answer ? review.answer() : { ok: true, text: JSON.stringify({ breakingChanges: [] }) }
      },
    },
  },
}))
const settings = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }))
vi.mock('../../../src/main/config-manager', () => ({
  readConfig: () => settings.value,
  readConfigChecked: () => ({ value: settings.value, outcome: settings.value ? 'ok' : 'absent' }),
}))
vi.mock('../../../src/main/account-profiles', () => ({
  resolveHeadlessProfileHome: () => ({ home: null, profileId: null }),
  listProfiles: () => [],
}))
const spawnClaudeHeadless = vi.fn(async (args: string[], _t?: number, _stdin?: string) => {
  if (args[0] === '--version') return { code: 0, stdout: '2.1.300 (Claude Code)', stderr: '' }
  return { code: 0, stdout: JSON.stringify({ type: 'result', result: JSON.stringify({ breakingChanges: [] }) }), stderr: '' }
})
vi.mock('../../../src/main/claude-headless', () => ({ spawnClaudeHeadless: (...a: unknown[]) => spawnClaudeHeadless(...(a as [string[], number, string])) }))
vi.mock('../../../src/main/sentinel/sentinel-model-article', () => ({ fetchArticleModelIds: async () => null }))
const fetchChangelog = vi.fn(async () => null as string | null)
vi.mock('../../../src/main/sentinel/sentinel-changelog', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/sentinel/sentinel-changelog')>()),
  fetchChangelog: () => fetchChangelog(),
}))
const fetchCodexReleaseNotes = vi.fn(async () => '## 0.156.1\n- a change\n\n## 0.155.1\n- older' as string | null)
vi.mock('../../../src/main/sentinel/sentinel-codex-changelog', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/sentinel/sentinel-codex-changelog')>()),
  fetchCodexReleaseNotes: () => fetchCodexReleaseNotes(),
}))

const SHIPPED = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.2']
const liveList = (version: string, ids: string[]) => ({ ok: true, version, models: ids.map((id) => ({ id, label: id.toUpperCase() })) })
const PREFIX = 'ccc-sentinel-codex-svc-'
let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX))
  svc.pref = { claude: 'on', codex: 'on' }
  svc.installation = { discoveryState: 'found', version: '0.155.1', compatibility: 'supported' }
  svc.catalogue = liveList('0.155.1', SHIPPED.filter((id) => id !== 'gpt-5.2'))
  svc.discovers = 0
  svc.catalogueReads = 0
  svc.holdDiscover = null
  svc.prepares = []
  svc.prepareAnswer = null
  svc.released = 0
  review.runs = []
  review.answer = null
  review.hold = null
  settings.value = null
  spawnClaudeHeadless.mockClear()
  fetchChangelog.mockClear()
  fetchCodexReleaseNotes.mockClear()
})
afterEach(() => {
  // TEST CLEANUP GUARD: only this suite's own state folder, by its prefix and parent.
  if (path.basename(dir).startsWith(PREFIX) && path.dirname(dir) === os.tmpdir()) fs.rmSync(dir, { recursive: true, force: true })
})

async function sentinel(seed?: Record<string, unknown>) {
  if (seed) {
    fs.mkdirSync(path.join(dir, 'sentinel'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'sentinel', 'sentinel-state.json'), JSON.stringify({ lastSeenCcVersion: null, analyzing: false, lastAnalysisAt: null, lastAnalysisError: null, findings: [], ...seed }))
  }
  const { _initRegistryForTest } = await import('../../../src/main/model-registry-service')
  _initRegistryForTest(dir)
  const mod = await import('../../../src/main/sentinel/index')
  mod.initSentinel(dir)
  return mod
}
const ids = (s: Awaited<ReturnType<typeof sentinel>>) => s.getSentinelState()!.snapshot().findings.map((f) => f.id)
const claudeAnalyses = () => spawnClaudeHeadless.mock.calls.filter((c) => c[0][0] === '-p')

describe('the Codex checks at start (rows 39, 42)', () => {
  it('Codex on: its version is checked and its live model list compared; the first check is a baseline, with no analysis', async () => {
    const s = await sentinel()
    await s.sentinelStartupCheck()
    expect(svc.discovers).toBe(1)
    expect(svc.catalogueReads).toBe(1)
    // 0.155.1 no longer lists gpt-5.2: said, for that version.
    expect(ids(s)).toContain('models:codex-retired:gpt-5.2')
    const f = s.getSentinelState()!.snapshot().findings.find((x) => x.id === 'models:codex-retired:gpt-5.2')!
    expect(f.title).toBe('GPT-5.2 is still selectable but Codex 0.155.1 no longer lists it')
    expect(s.getSentinelState()!.snapshot().lastSeenCodexVersion).toBe('0.155.1')
    expect(fetchCodexReleaseNotes).not.toHaveBeenCalled()
  })

  it('a version newer than tested, or too old, is a finding; one inside the range is not', async () => {
    svc.installation = { discoveryState: 'found', version: '0.157.1', compatibility: 'too-new' }
    const s = await sentinel()
    await s.sentinelStartupCheck()
    expect(ids(s)).toContain('codex-version:too-new:0.157.1')
    svc.installation = { discoveryState: 'found', version: '0.150.0', compatibility: 'too-old' }
    await s.sentinelStartupCheck()
    expect(ids(s)).toContain('codex-version:too-old:0.150.0')
    const old = s.getSentinelState()!.snapshot().findings.find((x) => x.id === 'codex-version:too-old:0.150.0')!
    expect(old.evidence).toContain('AI Code Conductor supports Codex 0.153.4 to 0.156.1.')
    expect(ids(s).filter((i) => i.startsWith('codex-version:'))).toHaveLength(2)
  })

  it('a live read that fails falls back to the shipped list (nothing about gpt-5.2, which the shipped list keeps)', async () => {
    svc.catalogue = { ok: false, code: 'failed', detail: 'exit 2' }
    const s = await sentinel()
    await s.sentinelStartupCheck()
    expect(svc.catalogueReads).toBe(1)
    expect(ids(s).some((i) => i.startsWith('models:codex-'))).toBe(false)
  })

  it('a CLI that was not found is not read and is no version finding (the Accounts row says it)', async () => {
    svc.installation = { discoveryState: 'missing', compatibility: 'unknown' }
    const s = await sentinel()
    await s.sentinelStartupCheck()
    expect(svc.catalogueReads).toBe(0)
    expect(ids(s).some((i) => i.startsWith('codex-'))).toBe(false)
    expect(s.getSentinelState()!.snapshot().lastSeenCodexVersion).toBeNull()
  })

  for (const pref of ['off', 'undecided'] as Pref[]) {
    it(`Codex ${pref}: nothing of it runs and nothing about it is said`, async () => {
      svc.pref.codex = pref
      const s = await sentinel({ lastSeenCodexVersion: '0.153.4' })
      await s.sentinelStartupCheck()
      expect(svc.discovers + svc.catalogueReads).toBe(0)
      expect(fetchCodexReleaseNotes).not.toHaveBeenCalled()
      expect(svc.prepares).toEqual([])
      expect(ids(s).some((i) => i.startsWith('codex-') || i.startsWith('models:codex-'))).toBe(false)
    })
  }
})

describe("the analysis of a Codex update, on the provider that is on (row 42; OD27 M4)", () => {
  it('both on, no Ask choice: the Codex update is analysed on Claude Code', async () => {
    const s = await sentinel({ lastSeenCcVersion: '2.1.300', lastSeenCodexVersion: '0.153.4' })
    await s.sentinelStartupCheck()
    expect(fetchCodexReleaseNotes).toHaveBeenCalledTimes(1)
    expect(claudeAnalyses()).toHaveLength(1)
    const stdin = claudeAnalyses()[0][2] as unknown as string
    expect(stdin).toContain('OpenAI Codex CLI')
    expect(stdin).toContain('--- RELEASE NOTES ---\n## 0.155.1\n- older')
    expect(svc.prepares).toEqual([])
    expect(s.getSentinelState()!.snapshot()).toMatchObject({ lastSeenCodexVersion: '0.155.1', analyzing: false, lastAnalysisError: null })
  })

  it('both on, Ask Conductor on Codex: it runs on Codex, as a reviewer launch in a fresh empty folder, removed after; no Claude analysis', async () => {
    settings.value = { askConductorProvider: 'codex' }
    review.answer = () => ({ ok: true, text: JSON.stringify({ breakingChanges: [{ title: 'Rollout format changed', evidence: '- a change', surface: 3, whatBreaks: 'status line readouts die' }] }) })
    const s = await sentinel({ lastSeenCcVersion: '2.1.300', lastSeenCodexVersion: '0.153.4' })
    await s.sentinelStartupCheck()
    expect(claudeAnalyses()).toHaveLength(0)
    expect(svc.prepares).toHaveLength(1)
    expect(svc.prepares[0]).toMatchObject({ kind: 'review', providerId: 'codex', remote: false })
    expect(String(svc.prepares[0].ownerId)).toMatch(/^sentinel:\d+$/)
    expect(svc.prepares[0].providerAccountId).toBeUndefined()
    expect(review.runs).toHaveLength(1)
    const run = review.runs[0]
    expect(run.executable).toBe('C:\\Tools\\codex.exe')
    expect(run.env).toEqual({ CODEX_HOME: 'C:\\realms\\realm-1' })
    expect(path.dirname(run.cwd)).toBe(os.tmpdir())
    expect(path.basename(run.cwd)).toMatch(/^ccc-sentinel-codex-/)
    expect(run.cwdExisted).toBe(true)
    expect(run.prompt).toContain('OpenAI Codex CLI')
    expect(run.timeoutMs).toBe(180000)
    // Gone after the run, and the account let go.
    expect(fs.existsSync(run.cwd)).toBe(false)
    expect(svc.released).toBe(1)
    expect(ids(s)).toContain('codex-update:0.155.1:0')
    expect(s.getSentinelState()!.snapshot().findings.find((f) => f.id === 'codex-update:0.155.1:0')).toMatchObject({ provider: 'codex', surface: 3, severity: 'high' })
  })

  it('Codex only: the Codex update runs on Codex and no Claude process starts at all', async () => {
    svc.pref.claude = 'off'
    const s = await sentinel({ lastSeenCodexVersion: '0.153.4' })
    await s.sentinelStartupCheck()
    expect(spawnClaudeHeadless).not.toHaveBeenCalled()
    expect(review.runs).toHaveLength(1)
    expect(s.getSentinelState()!.snapshot().lastSeenCodexVersion).toBe('0.155.1')
  })

  it("the chosen analysis account is used; one that cannot run falls back to Codex's review default, said in the label", async () => {
    svc.pref.claude = 'off'
    settings.value = { sentinelCodexAccountId: 'acct-gone' }
    svc.prepareAnswer = (input) => input.providerAccountId === 'acct-gone' ? { ok: false, code: 'not-found', message: 'That account is not available.' } : null
    review.answer = () => ({ ok: false, code: 'failed', message: "Codex exited with code 1: You've hit your usage limit." })
    const s = await sentinel({ lastSeenCodexVersion: '0.153.4' })
    await s.sentinelStartupCheck()
    expect(svc.prepares.map((p) => p.providerAccountId)).toEqual(['acct-gone', undefined])
    // A usage limit stops after one attempt, and names the account that ran.
    expect(review.runs).toHaveLength(1)
    const err = s.getSentinelState()!.snapshot().lastAnalysisError!
    expect(err).toContain('usage limit')
    expect(err).toContain('Work; auto-picked, your chosen analysis account could not be used')
    expect(s.getSentinelState()!.snapshot().lastSeenCodexVersion).toBe('0.153.4')
    expect(svc.released).toBe(1)
  })

  it('no Codex account can run it: the panel says why, and nothing runs', async () => {
    svc.pref.claude = 'off'
    svc.prepareAnswer = () => ({ ok: false, code: 'acknowledgement-required', message: 'This sign-in is unverified: confirm that this launch may use it.' })
    const s = await sentinel({ lastSeenCodexVersion: '0.153.4' })
    await s.sentinelStartupCheck()
    expect(review.runs).toHaveLength(0)
    expect(s.getSentinelState()!.snapshot().lastAnalysisError).toBe("Sentinel's analysis could not run on Codex: This sign-in is unverified: confirm that this launch may use it.")
  })

  it("Codex's release notes unavailable: a calm note, and the version is analysed again next time", async () => {
    fetchCodexReleaseNotes.mockImplementationOnce(async () => null)
    const s = await sentinel({ lastSeenCodexVersion: '0.153.4' })
    await s.sentinelStartupCheck()
    expect(s.getSentinelState()!.snapshot()).toMatchObject({ analyzing: false, lastAnalysisError: "Codex's release notes could not be read (offline?). Use Re-run in the Sentinel panel.", lastSeenCodexVersion: '0.153.4' })
  })

  it('Codex switched off while its notes were fetched: not analysed, and the panel says why', async () => {
    fetchCodexReleaseNotes.mockImplementationOnce(async () => { svc.pref.codex = 'off'; return '## 0.155.1\n- x' })
    const s = await sentinel({ lastSeenCodexVersion: '0.153.4' })
    await s.sentinelStartupCheck()
    expect(claudeAnalyses()).toHaveLength(0)
    expect(review.runs).toHaveLength(0)
    expect(s.getSentinelState()!.snapshot().lastAnalysisError).toBe('Codex is off. Turn it on in Settings, Accounts.')
  })

  it('both updated at once: each is analysed, Claude Code first, and each version is recorded', async () => {
    fetchChangelog.mockImplementation(async () => '## 2.1.300\n- claude change')
    const s = await sentinel({ lastSeenCcVersion: '2.1.200', lastSeenCodexVersion: '0.153.4' })
    await s.sentinelStartupCheck()
    fetchChangelog.mockImplementation(async () => null)
    const prompts = claudeAnalyses().map((c) => String(c[2]))
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('--- CHANGELOG ---')
    expect(prompts[1]).toContain('--- RELEASE NOTES ---')
    expect(s.getSentinelState()!.snapshot()).toMatchObject({ lastSeenCcVersion: '2.1.300', lastSeenCodexVersion: '0.155.1', lastAnalysisError: null })
  })
})

describe("Sentinel's Codex runs are Codex in use while they run", () => {
  it('the version check and model list read: counted from the launch check to the end, then not', async () => {
    let release!: () => void
    svc.holdDiscover = new Promise<void>((r) => { release = r })
    const s = await sentinel()
    const pending = s.sentinelStartupCheck()
    for (let i = 0; i < 20 && svc.discovers === 0; i++) await new Promise<void>((r) => setTimeout(r, 0))
    expect(s.sentinelCodexRunsInFlight()).toBe(1)
    expect(s.sentinelClaudeRunsInFlight()).toBe(0)
    release()
    await pending
    expect(s.sentinelCodexRunsInFlight()).toBe(0)
  })

  it('an analysis on Codex: counted while it runs, then not; the folder and the lease go with it', async () => {
    svc.pref.claude = 'off'
    let release!: () => void
    review.hold = new Promise<void>((r) => { release = r })
    const s = await sentinel({ lastSeenCodexVersion: '0.153.4' })
    const pending = s.sentinelStartupCheck()
    for (let i = 0; i < 40 && review.runs.length === 0; i++) await new Promise<void>((r) => setTimeout(r, 0))
    expect(review.runs).toHaveLength(1)
    expect(s.sentinelCodexRunsInFlight()).toBe(1)
    expect(fs.existsSync(review.runs[0].cwd)).toBe(true)
    release()
    await pending
    expect(s.sentinelCodexRunsInFlight()).toBe(0)
    expect(fs.existsSync(review.runs[0].cwd)).toBe(false)
    expect(svc.released).toBe(1)
  })

  it('a stopped run whose kill is still under way keeps its folder and lease until that kill has finished', async () => {
    svc.pref.claude = 'off'
    let finishKill!: () => void
    const killSettled = new Promise<void>((r) => { finishKill = r })
    review.answer = () => ({ ok: false, code: 'timed-out', message: 'The review timed out.', killSettled })
    const s = await sentinel({ lastSeenCodexVersion: '0.153.4' })
    await s.sentinelStartupCheck()
    expect(review.runs).toHaveLength(2)                        // a timeout is retried once, as Claude's
    expect(svc.released).toBe(0)
    expect(fs.existsSync(review.runs[0].cwd)).toBe(true)
    expect(s.sentinelCodexRunsInFlight()).toBe(1)
    finishKill()
    await killSettled
    await new Promise<void>((r) => setTimeout(r, 0))
    expect(svc.released).toBe(1)
    expect(fs.existsSync(review.runs[0].cwd)).toBe(false)
    expect(s.sentinelCodexRunsInFlight()).toBe(0)
    expect(s.getSentinelState()!.snapshot().lastAnalysisError).toMatch(/could not finish in time/)
  })
})

describe('a Re-run (P3.9)', () => {
  it('Claude Code off, Codex on: no Claude process; Codex is checked again and its update analysed', async () => {
    svc.pref.claude = 'off'
    const s = await sentinel({ lastSeenCodexVersion: '0.155.1' })
    await s.sentinelRerun()
    expect(spawnClaudeHeadless).not.toHaveBeenCalled()
    expect(svc.discovers).toBe(1)
    expect(review.runs).toHaveLength(1)
    expect(s.getSentinelState()!.snapshot()).toMatchObject({ analyzing: false, lastAnalysisError: null })
  })

  it('an installed Codex that cannot be checked is said; Claude Code is still analysed', async () => {
    svc.installation = { discoveryState: 'error', compatibility: 'unknown' }
    fetchChangelog.mockImplementationOnce(async () => '## 2.1.300\n- x')
    const s = await sentinel({ lastSeenCcVersion: '2.1.300' })
    await s.sentinelRerun()
    expect(claudeAnalyses()).toHaveLength(1)
    expect(s.getSentinelState()!.snapshot().lastAnalysisError).toBe('The installed Codex could not be checked, so its update was not analysed. Check it in Settings, Accounts, then use Re-run.')
  })

  it('a Claude-only user: Codex, not set up, is never looked at, and nothing is said about it', async () => {
    svc.pref.codex = 'undecided'
    fetchChangelog.mockImplementationOnce(async () => '## 2.1.300\n- x')
    const s = await sentinel({ lastSeenCcVersion: '2.1.300' })
    await s.sentinelRerun()
    expect(svc.discovers + svc.catalogueReads).toBe(0)
    expect(spawnClaudeHeadless).toHaveBeenCalledWith(['--version'], 15000, undefined, null)
    expect(claudeAnalyses()).toHaveLength(1)
    // A provider that is off shows nothing: not even why it was not checked.
    expect(s.getSentinelState()!.snapshot()).toMatchObject({ analyzing: false, lastAnalysisError: null })
  })
})
