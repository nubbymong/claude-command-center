/**
 * P3.9 (rows 39, 42): Sentinel for Codex, through the REAL Sentinel service.
 *
 *  - While Codex is on, the start-up check and a Re-run check the installed
 *    Codex's version against the supported range, compare the model registry
 *    with the list that CLI offers (the live read), and analyse Codex's
 *    release notes when its version is newer than the last one checked
 *    (fixer 10: a lower one is not analysed at start, for both providers, so
 *    versions installed in turn stay within the cap). While it is off or not
 *    set up, nothing of it runs and nothing about it is said.
 *  - The analysis runs on the provider that is on: with both on, the one Ask
 *    Conductor runs on (Claude Code by default); Codex only, on Codex, as a
 *    prepared reviewer launch running a text-only analysis in a fresh empty
 *    folder that is its own project root, in Sentinel's own runs folder, and
 *    removed after (round 1).
 *  - Sentinel's Codex runs count as Codex in use while they run.
 *
 * The accounts service, the Codex package's reviewer, the headless Claude
 * spawner, the network fetches and the settings are faked: no process
 * starts, no request leaves, and the only folders made are this suite's own
 * state folder and what the service makes (and removes) inside it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { SentinelStateSnapshot } from '../../../src/shared/sentinel-types'
import { sentinelVersionParts, sentinelCompatibleSubject, CLAUDE_ONLY_SCOPE } from '../../../src/renderer/components/sentinel/sentinel-report-text'

// P3.9 round 2 (F2): a hook run once just before the next mkdtemp, to move
// the runs folder between the check and the make.
const fsHooks = vi.hoisted(() => ({ beforeMkdtemp: null as null | ((prefix: string) => void) }))
vi.mock('fs', async (orig) => {
  const real = await orig<typeof import('fs')>()
  const mkdtempSync = ((prefix: string, opts?: unknown) => {
    const h = fsHooks.beforeMkdtemp
    if (h) { fsHooks.beforeMkdtemp = null; h(prefix) }
    return (real.mkdtempSync as (p: string, o?: unknown) => string)(prefix, opts)
  }) as typeof real.mkdtempSync
  return { ...real, mkdtempSync, default: { ...real, mkdtempSync } }
})
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
  holdRead: null as null | Promise<void>,
  prepares: [] as Array<Record<string, unknown>>,
  prepareAnswer: null as null | ((input: Record<string, unknown>) => Record<string, unknown> | null),
  released: 0,
  poisoned: false,
}))
const review = vi.hoisted(() => ({
  runs: [] as Array<{ executable: string; env: Record<string, string>; cwd: string; prompt: string; timeoutMs: number; purpose?: string; listing: string[]; markerEmptyFile: boolean }>,
  answer: null as null | (() => Record<string, unknown>),
  hold: null as null | Promise<void>,
}))
// An installation whose facts cannot even be read (round 1, Q1): the Codex
// half fails outright, on the look discovery took or on the one at start.
const installationOf = (id: string): Record<string, unknown> => svc.poisoned
  ? Object.defineProperty({ providerId: id }, 'discoveryState', { enumerable: true, get() { throw new Error('boom') } })
  : { providerId: id, ...svc.installation }
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
      if (refusal(id)) return { ok: false, code: 'provider-disabled', message: 'off' }
      return { ok: true, installation: installationOf(id) }
    },
    readModelCatalogue: async (id: string) => {
      svc.catalogueReads++
      if (svc.holdRead) await svc.holdRead
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
    snapshot: () => ({
      providers: [installationOf('codex')],
      accounts: [{ id: 'acct-work', identityId: 'id-1', providerLabel: 'work@example.com' }],
      identities: [{ id: 'id-1', friendlyName: 'Work' }],
    }),
  }),
}))
vi.mock('../../../src/main/providers/core', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/providers/core')>()),
  tryGetProviderPackage: (id: string) => id === 'claude' ? (transport.pick ? { id, managedLaunch: { transportSettingsEnv: (raw: string) => transport.pick!(raw) } } : null) : id !== 'codex' ? null : {
    id, displayName: 'Codex',
    setup: { supportedVersions: { minimum: '0.153.4', maximumTested: '0.156.1' } },
    review: {
      run: async (input: { executable: string; env: Record<string, string>; cwd: string; prompt: string; timeoutMs: number; purpose?: string }) => {
        const marker = path.join(input.cwd, '.git')
        review.runs.push({ ...input, listing: fs.readdirSync(input.cwd), markerEmptyFile: fs.statSync(marker).isFile() && fs.statSync(marker).size === 0 })
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
  // Round 3: the default account's Claude folder is this suite's own.
  sharedRoot: () => path.join(dir, 'shared-claude'),
}))
/** Round 2: where each Claude analysis ran, as it started. */
const claudeRuns: Array<{ cwd: string; listing: string[]; env: Record<string, string> | undefined; transportEnv?: Record<string, string> }> = []
/** Round 3: the Claude package's transport picker (none unless a case sets it). */
const transport = vi.hoisted(() => ({ pick: null as null | ((raw: string) => Record<string, string>) }))
const versionThrows = vi.hoisted(() => ({ on: false }))
/** Fixer 10: the Claude Code version installed, and its analysis's reply (none: no findings). */
/** Fixer 13: `versionCode`, the exit code of `claude --version` (not 0: the version is unavailable). */
const claude = vi.hoisted(() => ({ version: '2.1.300', answer: null as null | string, versionCode: 0 }))
const spawnClaudeHeadless = vi.fn(async (args: string[], _t?: number, _stdin?: string, _home?: string | null, _signal?: AbortSignal, opts?: { cwd?: string; env?: Record<string, string>; transportEnv?: Record<string, string> }) => {
  if (args[0] === '--version') {
    if (versionThrows.on) throw new Error('the version check broke')
    return { code: claude.versionCode, stdout: claude.versionCode === 0 ? `${claude.version} (Claude Code)` : '', stderr: '' }
  }
  if (opts?.cwd) claudeRuns.push({ cwd: opts.cwd, listing: fs.readdirSync(opts.cwd), env: opts.env, transportEnv: opts.transportEnv })
  return { code: 0, stdout: JSON.stringify({ type: 'result', result: claude.answer ?? JSON.stringify({ breakingChanges: [] }) }), stderr: '' }
})
vi.mock('../../../src/main/claude-headless', () => ({ spawnClaudeHeadless: (...a: unknown[]) => spawnClaudeHeadless(...(a as [string[], number, string])) }))
vi.mock('../../../src/main/sentinel/sentinel-model-article', () => ({ fetchArticleModelIds: async () => null }))
const fetchChangelog = vi.fn(async () => null as string | null)
vi.mock('../../../src/main/sentinel/sentinel-changelog', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/sentinel/sentinel-changelog')>()),
  fetchChangelog: () => fetchChangelog(),
}))
type Notes = { text: string; versions: string[]; cut: string | null } | null
const NOTES_TEXT = '## 0.155.1\n- The rollout file format changed.\n\n## 0.154.0\n- Various older fixes and improvements.'
const fetchCodexReleaseNotes = vi.fn(async (_last: string | null, _installed: string): Promise<Notes> => ({ text: NOTES_TEXT, versions: ['0.155.1', '0.154.0'], cut: null }))
vi.mock('../../../src/main/sentinel/sentinel-codex-changelog', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/sentinel/sentinel-codex-changelog')>()),
  fetchCodexReleaseNotes: (last: string | null, installed: string) => fetchCodexReleaseNotes(last, installed),
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
  svc.holdRead = null
  svc.prepares = []
  svc.prepareAnswer = null
  svc.released = 0
  svc.poisoned = false
  review.runs = []
  review.answer = null
  review.hold = null
  settings.value = null
  spawnClaudeHeadless.mockClear()
  claudeRuns.length = 0
  transport.pick = null
  versionThrows.on = false
  claude.version = '2.1.300'
  claude.answer = null
  claude.versionCode = 0
  fsHooks.beforeMkdtemp = null
  fetchChangelog.mockClear()
  fetchChangelog.mockImplementation(async () => null)
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
const runsDir = () => path.join(dir, 'sentinel', 'runs')
const reply = (evidence: string) => ({ ok: true, text: JSON.stringify({ breakingChanges: [{ title: 'Rollout format changed', evidence, surface: 3, whatBreaks: 'status line readouts die' }] }) })

describe('the Codex checks at start (rows 39, 42)', () => {
  it('Codex on: its version (the look the app took at start) and its live model list; the first check is a baseline, with no analysis', async () => {
    const s = await sentinel()
    await s.sentinelStartupCheck()
    // Round 1: the start-up check does not run a second --version; the read
    // uses (or, when there is none, makes) the app's own look.
    expect(svc.discovers).toBe(0)
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

  it('a CLI that was not found gives no model list and no version finding (the Accounts row says it)', async () => {
    svc.installation = { discoveryState: 'missing', compatibility: 'unknown' }
    svc.catalogue = { ok: false, code: 'not-proven', detail: 'x' }
    const s = await sentinel()
    await s.sentinelStartupCheck()
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

  it("the Codex half failing never stops Claude Code's check (round 1)", async () => {
    svc.poisoned = true
    const s = await sentinel()
    await expect(s.sentinelStartupCheck()).resolves.toBeUndefined()
    expect(spawnClaudeHeadless).toHaveBeenCalledWith(['--version'], 15000, undefined, null)
    expect(s.getSentinelState()!.snapshot().lastSeenCcVersion).toBe('2.1.300')
    expect(s.sentinelCodexRunsInFlight()).toBe(0)
  })
})

describe("the analysis of a Codex update, on the provider that is on (row 42; OD27 M4)", () => {
  it('both on, no Ask choice: the Codex update is analysed on Claude Code, with no tools', async () => {
    const s = await sentinel({ lastSeenCcVersion: '2.1.300', lastSeenCodexVersion: '0.153.4' })
    await s.sentinelStartupCheck()
    expect(fetchCodexReleaseNotes).toHaveBeenCalledTimes(1)
    expect(fetchCodexReleaseNotes).toHaveBeenCalledWith('0.153.4', '0.155.1')
    expect(claudeAnalyses()).toHaveLength(1)
    expect(claudeAnalyses()[0][0]).toContain('--strict-mcp-config')
    expect(claudeAnalyses()[0][0]).toContain('--disallowedTools')
    const stdin = claudeAnalyses()[0][2] as unknown as string
    expect(stdin).toContain('OpenAI Codex CLI')
    expect(stdin).toMatch(/--- BEGIN RELEASE NOTES [0-9a-f]{16} ---\n## 0\.155\.1\n- The rollout file format changed\./)
    expect(svc.prepares).toEqual([])
    expect(s.getSentinelState()!.snapshot()).toMatchObject({ lastSeenCodexVersion: '0.155.1', analyzing: false, lastAnalysisError: null })
  })

  it("round 2: Claude Code's analysis runs in a fresh empty folder of its own in Sentinel's runs folder, with its switches; the folder goes after", async () => {
    const s = await sentinel({ lastSeenCcVersion: '2.1.300', lastSeenCodexVersion: '0.153.4' })
    await s.sentinelStartupCheck()
    expect(claudeRuns).toHaveLength(1)
    const run = claudeRuns[0]
    expect(path.dirname(run.cwd)).toBe(path.resolve(runsDir()))
    expect(path.basename(run.cwd)).toMatch(/^ccc-sentinel-claude-/)
    expect(run.listing).toEqual([])
    expect(run.env).toEqual({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1' })
    expect(fs.existsSync(run.cwd)).toBe(false)
    // The version check is not an analysis: it runs as before.
    expect(spawnClaudeHeadless).toHaveBeenCalledWith(['--version'], 15000, undefined, null)
  })

  it("round 2: a Claude Code check that breaks is said, and the Codex update is still analysed", async () => {
    versionThrows.on = true
    svc.pref.claude = 'on'
    settings.value = { askConductorProvider: 'codex' }
    review.answer = () => reply('- The rollout file format changed.')
    const s = await sentinel({ lastSeenCcVersion: '2.1.300', lastSeenCodexVersion: '0.153.4' })
    await expect(s.sentinelStartupCheck()).resolves.toBeUndefined()
    expect(review.runs).toHaveLength(1)
    const snap = s.getSentinelState()!.snapshot()
    expect(snap.lastSeenCodexVersion).toBe('0.155.1')
    expect(snap.lastAnalysisError).toContain('the version check broke')
    expect(snap.findings.some((f) => f.id.startsWith('codex-update:0.155.1:'))).toBe(true)
  })

  it('both on, Ask Conductor on Codex: a text-only run on Codex, in a fresh folder that is its own project root in Sentinel\'s runs folder, removed after; no Claude analysis', async () => {
    settings.value = { askConductorProvider: 'codex' }
    review.answer = () => reply('- The rollout file format changed.')
    const s = await sentinel({ lastSeenCcVersion: '2.1.300', lastSeenCodexVersion: '0.153.4' })
    await s.sentinelStartupCheck()
    expect(claudeAnalyses()).toHaveLength(0)
    expect(svc.prepares).toHaveLength(1)
    expect(svc.prepares[0]).toMatchObject({ kind: 'review', providerId: 'codex', remote: false })
    expect(String(svc.prepares[0].ownerId)).toMatch(/^sentinel:\d+$/)
    expect(svc.prepares[0].providerAccountId).toBeUndefined()
    // Never on an unverified sign-in: no launch is acknowledged for it.
    expect(svc.prepares[0].acknowledgeRealmOnly).toBeUndefined()
    expect(review.runs).toHaveLength(1)
    const run = review.runs[0]
    expect(run.purpose).toBe('analysis')
    expect(run.executable).toBe('C:\\Tools\\codex.exe')
    // Round 2: any git the CLI runs stops at the runs folder and never prompts.
    expect(run.env).toEqual({ CODEX_HOME: 'C:\\realms\\realm-1', GIT_CEILING_DIRECTORIES: runsDir(), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' })
    // Round 1: in the app's own runs folder, never the shared temp folder.
    expect(path.dirname(run.cwd)).toBe(path.resolve(runsDir()))
    expect(path.basename(run.cwd)).toMatch(/^ccc-sentinel-codex-/)
    // Empty but for the project-root marker, made before the run started.
    expect(run.listing).toEqual(['.git'])
    expect(run.markerEmptyFile).toBe(true)
    expect(run.prompt).toContain('OpenAI Codex CLI')
    expect(run.timeoutMs).toBe(180000)
    // Gone after the run, and the account let go.
    expect(fs.existsSync(run.cwd)).toBe(false)
    expect(svc.released).toBe(1)
    const f = s.getSentinelState()!.snapshot().findings.find((x) => x.id.startsWith('codex-update:0.155.1:'))
    expect(f).toMatchObject({ provider: 'codex', surface: 3, severity: 'high' })
  })

  it('a finding that does not quote the notes sent is dropped; round 3: the version is then not checked, and the panel says why', async () => {
    svc.pref.claude = 'off'
    review.answer = () => reply('{"tokens":{"refresh_token":"FAKE"}}')
    const s = await sentinel({ lastSeenCodexVersion: '0.153.4' })
    await s.sentinelStartupCheck()
    expect(ids(s).some((i) => i.startsWith('codex-update:'))).toBe(false)
    const snap = s.getSentinelState()!.snapshot()
    expect(snap.lastSeenCodexVersion).toBe('0.153.4')
    expect(snap.lastAnalysisError).toBe('One finding from the analysis of Codex 0.155.1 could not be matched to its release notes, so it is not shown and the update will be analysed again at the next check.')
  })

  it("round 3: the analysis account's network settings (proxy, certificates) reach the Claude run; nothing else of its settings file", async () => {
    transport.pick = (raw: string) => {
      const env = (JSON.parse(raw) as { env: Record<string, string> }).env
      return { HTTPS_PROXY: env.HTTPS_PROXY, NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS }
    }
    fs.mkdirSync(path.join(dir, 'shared-claude'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'shared-claude', 'settings.json'), JSON.stringify({ env: { HTTPS_PROXY: 'http://proxy.example:8080', NODE_EXTRA_CA_CERTS: '/etc/ca.pem', ANTHROPIC_API_KEY: 'x' } }))
    const s = await sentinel({ lastSeenCcVersion: '2.1.300', lastSeenCodexVersion: '0.153.4' })
    await s.sentinelStartupCheck()
    expect(claudeRuns).toHaveLength(1)
    expect(claudeRuns[0].transportEnv).toEqual({ HTTPS_PROXY: 'http://proxy.example:8080', NODE_EXTRA_CA_CERTS: '/etc/ca.pem' })
  })

  it('round 4: an update whose findings never match is analysed at most 3 times, then recorded as checked with a note', async () => {
    svc.pref.claude = 'off'
    review.answer = () => reply('{"tokens":{"refresh_token":"FAKE"}}')
    const s = await sentinel({ lastSeenCodexVersion: '0.153.4' })
    for (let i = 1; i <= 2; i++) {
      await s.sentinelStartupCheck()
      const snap = s.getSentinelState()!.snapshot()
      expect(snap.lastSeenCodexVersion, `start ${i}`).toBe('0.153.4')
      expect(snap.lastAnalysisError, `start ${i}`).toContain('will be analysed again at the next check')
    }
    await s.sentinelStartupCheck()
    const snap = s.getSentinelState()!.snapshot()
    expect(review.runs).toHaveLength(3)
    expect(snap.lastSeenCodexVersion).toBe('0.155.1')
    expect(snap.lastAnalysisError).toBeNull()
    expect(snap.lastAnalysisNote).toBe('One finding from the analysis of Codex 0.155.1 could not be matched to its release notes after 3 analyses, so it is not shown and the update is recorded as checked.')
    expect(snap.unverifiedTries ?? {}).toEqual({})
    // Checked now: the next start runs no analysis of it.
    await s.sentinelStartupCheck()
    expect(review.runs).toHaveLength(3)
  })

  it('Codex only: the Codex update runs on Codex and no Claude process starts at all', async () => {
    svc.pref.claude = 'off'
    const s = await sentinel({ lastSeenCodexVersion: '0.153.4' })
    await s.sentinelStartupCheck()
    expect(spawnClaudeHeadless).not.toHaveBeenCalled()
    expect(review.runs).toHaveLength(1)
    expect(s.getSentinelState()!.snapshot().lastSeenCodexVersion).toBe('0.155.1')
  })

  it("the chosen analysis account is used; one that cannot run falls back to Codex's review default, said in the label; neither is ever acknowledged", async () => {
    svc.pref.claude = 'off'
    settings.value = { sentinelCodexAccountId: 'acct-gone' }
    svc.prepareAnswer = (input) => input.providerAccountId === 'acct-gone' ? { ok: false, code: 'not-found', message: 'That account is not available.' } : null
    review.answer = () => ({ ok: false, code: 'failed', message: "Codex exited with code 1: You've hit your usage limit." })
    const s = await sentinel({ lastSeenCodexVersion: '0.153.4' })
    await s.sentinelStartupCheck()
    expect(svc.prepares.map((p) => p.providerAccountId)).toEqual(['acct-gone', undefined])
    expect(svc.prepares.map((p) => p.acknowledgeRealmOnly)).toEqual([undefined, undefined])
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
    expect(s.getSentinelState()!.snapshot()).toMatchObject({ analyzing: false, lastAnalysisError: "Codex's release notes could not be read from GitHub. Use Re-run in the Sentinel panel.", lastSeenCodexVersion: '0.153.4' })
  })

  it('notes read only in part: the analysis completes and the panel is told so (round 1)', async () => {
    fetchCodexReleaseNotes.mockImplementationOnce(async () => ({ text: NOTES_TEXT, versions: ['0.155.1'], cut: 'Some notes were cut.' }))
    const s = await sentinel({ lastSeenCodexVersion: '0.153.4' })
    await s.sentinelStartupCheck()
    expect(s.getSentinelState()!.snapshot()).toMatchObject({ analyzing: false, lastAnalysisError: null, lastAnalysisNote: 'Some notes were cut.', lastSeenCodexVersion: '0.155.1' })
  })

  it('round 2: notes read only in part are said even when the analysis does not complete', async () => {
    svc.pref.claude = 'off'
    fetchCodexReleaseNotes.mockImplementationOnce(async () => ({ text: NOTES_TEXT, versions: ['0.155.1'], cut: 'Some notes were cut.' }))
    review.answer = () => ({ ok: false, code: 'failed', message: 'Codex exited with code 1: unexpected status 400 Bad Request.' })
    const s = await sentinel({ lastSeenCodexVersion: '0.153.4' })
    await s.sentinelStartupCheck()
    const snap = s.getSentinelState()!.snapshot()
    expect(snap.lastAnalysisNote).toBe('Some notes were cut.')
    expect(snap.lastAnalysisError).toContain('unexpected status 400')
    expect(snap.lastAnalysisError).not.toMatch(/busy|rate limited/)
  })

  it('Codex switched off while its notes were fetched: not analysed, and the panel says why', async () => {
    fetchCodexReleaseNotes.mockImplementationOnce(async () => { svc.pref.codex = 'off'; return { text: NOTES_TEXT, versions: ['0.155.1'], cut: null } })
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
    expect(prompts[0]).toMatch(/--- BEGIN CHANGELOG [0-9a-f]{16} ---/)
    expect(prompts[1]).toMatch(/--- BEGIN RELEASE NOTES [0-9a-f]{16} ---/)
    expect(s.getSentinelState()!.snapshot()).toMatchObject({ lastSeenCcVersion: '2.1.300', lastSeenCodexVersion: '0.155.1', lastAnalysisError: null })
  })
})

describe("the analysis folders (round 1)", () => {
  it('round 2: a runs folder that became a link between the check and the make is refused; nothing runs and nothing is left there', async () => {
    svc.pref.claude = 'off'
    const elsewhere = path.join(dir, 'elsewhere')
    fs.mkdirSync(elsewhere)
    fsHooks.beforeMkdtemp = () => {
      fs.renameSync(runsDir(), runsDir() + '-was')
      fs.symlinkSync(elsewhere, runsDir(), 'junction')
    }
    const s = await sentinel({ lastSeenCodexVersion: '0.153.4' })
    await s.sentinelStartupCheck()
    expect(fsHooks.beforeMkdtemp).toBeNull()
    expect(review.runs).toHaveLength(0)
    expect(fs.readdirSync(elsewhere)).toEqual([])
    expect(svc.released).toBe(1)
    expect(s.getSentinelState()!.snapshot().lastAnalysisError).toBe("Sentinel's analysis could not run on Codex: no empty folder could be made for it.")
  })

  it('leftovers of earlier runs (own prefix, an hour old, real folders) are swept; a young one, another name and a link are left', async () => {
    svc.pref.claude = 'off'
    fs.mkdirSync(runsDir(), { recursive: true })
    const old = path.join(runsDir(), 'ccc-sentinel-codex-OLD111')
    const young = path.join(runsDir(), 'ccc-sentinel-codex-YOUNG1')
    const other = path.join(runsDir(), 'something-else')
    const target = path.join(dir, 'link-target')
    for (const d of [old, young, other, target]) fs.mkdirSync(d)
    fs.writeFileSync(path.join(target, 'keep.txt'), 'x')
    const link = path.join(runsDir(), 'ccc-sentinel-codex-LINK11')
    fs.symlinkSync(target, link, 'junction')
    const hourAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000
    for (const d of [old, other]) fs.utimesSync(d, hourAgo, hourAgo)
    try { fs.lutimesSync(link, hourAgo, hourAgo) } catch { /* not everywhere */ }
    const s = await sentinel({ lastSeenCodexVersion: '0.153.4' })
    await s.sentinelStartupCheck()
    expect(review.runs).toHaveLength(1)
    expect(fs.existsSync(old)).toBe(false)
    expect(fs.existsSync(young)).toBe(true)
    expect(fs.existsSync(other)).toBe(true)
    expect(fs.existsSync(path.join(target, 'keep.txt'))).toBe(true)
  })

  it('a runs folder that is a link (not the app\'s own folder) is refused: nothing runs, the lease goes', async () => {
    svc.pref.claude = 'off'
    const elsewhere = path.join(dir, 'elsewhere')
    fs.mkdirSync(elsewhere)
    fs.mkdirSync(path.join(dir, 'sentinel'), { recursive: true })
    fs.symlinkSync(elsewhere, runsDir(), 'junction')
    const s = await sentinel({ lastSeenCodexVersion: '0.153.4' })
    await s.sentinelStartupCheck()
    expect(review.runs).toHaveLength(0)
    expect(svc.released).toBe(1)
    expect(fs.readdirSync(elsewhere)).toEqual([])
    expect(s.getSentinelState()!.snapshot().lastAnalysisError).toBe("Sentinel's analysis could not run on Codex: no empty folder could be made for it.")
  })
})

describe("Sentinel's Codex runs are Codex in use while they run", () => {
  it('the version check and model list read: counted from the launch check to the end of the read, then not', async () => {
    let release!: () => void
    svc.holdRead = new Promise<void>((r) => { release = r })
    const s = await sentinel()
    const pending = s.sentinelStartupCheck()
    for (let i = 0; i < 20 && svc.catalogueReads === 0; i++) await new Promise<void>((r) => setTimeout(r, 0))
    expect(s.sentinelCodexRunsInFlight()).toBe(1)
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
  it('Claude Code off, Codex on: no Claude process; Codex is checked afresh and its own notes analysed again', async () => {
    svc.pref.claude = 'off'
    const s = await sentinel({ lastSeenCodexVersion: '0.155.1' })
    await s.sentinelRerun()
    expect(spawnClaudeHeadless).not.toHaveBeenCalled()
    expect(svc.discovers).toBe(1)
    expect(fetchCodexReleaseNotes).toHaveBeenCalledWith('0.155.1', '0.155.1')
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

// Fixer 10 (gate 3 F9, ADR-009 C1 and D1, row 42): the cap of
// UNVERIFIED_MAX_TRIES analyses holds for versions installed in turn (two
// installs, or two machines sharing one resources folder), for both
// providers. A start analyses only a version higher than the highest one
// checked, and a version's count of unmatched analyses is dropped only once
// a version at or above it is recorded. Fixer 11 (gate 3 F10, ADR-009 D1
// round 2, R2-1): no start and no analysis of a lower version lowers the
// highest version checked, the panel names the version installed at the last
// completed check, and a recorded version that is not a string loads as none.
// Fixer 12 (ADR-009 R3-1): a Re-run's record, the user's own act, sets the
// highest version checked to its version. Each start below is a relaunch:
// Sentinel is read again from its file, the real start-up check runs.
for (const p of ['codex', 'claude'] as const) {
  const name = p === 'codex' ? 'Codex' : 'Claude Code'
  const [LAST, A, B, C] = p === 'codex' ? ['0.153.4', '0.155.1', '0.156.0', '0.157.0'] : ['2.1.300', '2.1.301', '2.1.302', '2.1.303']
  const scope = p === 'codex' ? { claudeOn: false, codexOn: true } : CLAUDE_ONLY_SCOPE
  /** Only `p` is on; its notes cover every version used here. */
  function only(): void {
    svc.pref = p === 'codex' ? { claude: 'off', codex: 'on' } : { claude: 'on', codex: 'off' }
    fetchChangelog.mockImplementation(async () => `## ${C}\n- c change\n\n## ${B}\n- b change\n\n## ${A}\n- a change\n`)
  }
  /** Every analysis from now on has a finding that quotes nothing in its notes. */
  function unmatched(): void {
    const text = JSON.stringify({ breakingChanges: [{ title: 'Rollout format changed', evidence: '{"tokens":{"refresh_token":"FAKE"}}', surface: 3, whatBreaks: 'status line readouts die' }] })
    if (p === 'codex') review.answer = () => ({ ok: true, text })
    else claude.answer = text
  }
  /** From now on every analysis's findings match its notes (it finds none). */
  function matched(): void {
    if (p === 'codex') review.answer = null
    else claude.answer = null
  }
  const install = (version: string) => {
    if (p === 'codex') svc.installation = { discoveryState: 'found', version, compatibility: 'supported' }
    else claude.version = version
  }
  const analyses = () => (p === 'codex' ? review.runs.length : claudeAnalyses().length)
  type Start = { version: string; analysed: number; shown: string | null; checked: string | null }
  const shownOf = (snap: SentinelStateSnapshot) => (p === 'codex' ? snap.lastSeenCodexVersion : snap.lastSeenCcVersion) ?? null
  const checkedOf = (snap: SentinelStateSnapshot) => (p === 'codex' ? snap.highestCheckedCodexVersion : snap.highestCheckedCcVersion) ?? null
  /** One start of the app with `version` installed: whether it ran an
   *  analysis, the version the panel then names, and the highest checked. */
  async function startOn(version: string): Promise<Start> {
    install(version)
    const before = analyses()
    const s = await sentinel()
    await s.sentinelStartupCheck()
    const snap = s.getSentinelState()!.snapshot()
    return { version, analysed: analyses() - before, shown: shownOf(snap), checked: checkedOf(snap) }
  }
  const seed = (last: unknown) => sentinel(p === 'codex' ? { lastSeenCodexVersion: last } : { lastSeenCcVersion: last })

  describe(`fixer 10: ${name} versions installed in turn stay within the cap`, () => {
    it('40 starts taking two versions in turn, findings never matched: each is analysed three times, recorded at its third, then never again', async () => {
      only()
      unmatched()
      await seed(LAST)
      const trace: Start[] = []
      for (let i = 0; i < 40; i++) trace.push(await startOn(i % 2 === 0 ? A : B))
      const runs = (v: string) => trace.filter((t) => t.version === v && t.analysed > 0).length
      expect(trace.every((t) => t.analysed <= 1)).toBe(true)
      expect([runs(A), runs(B)]).toEqual([3, 3])
      // Each recorded at its own third analysis: A at start 5, B at start 6.
      expect(trace.slice(0, 6).map((t) => t.checked)).toEqual([LAST, LAST, LAST, LAST, A, B])
      expect(trace.at(-1)!.checked).toBe(B)
      // Once both are checked, the panel names the version installed.
      expect(trace.slice(6).every((t) => t.shown === t.version)).toBe(true)
    })

    it('the same 40 starts with findings that match: each version analysed once, two in all', async () => {
      only()
      await seed(LAST)
      const trace: Start[] = []
      for (let i = 0; i < 40; i++) trace.push(await startOn(i % 2 === 0 ? A : B))
      expect(trace.filter((t) => t.analysed > 0).map((t) => t.version)).toEqual([A, B])
      expect(trace.at(-1)!.checked).toBe(B)
      expect(trace.every((t) => t.shown === t.version)).toBe(true)
    })

    it('A, A, B taken in turn (ADR-009 D1): A is recorded at its third analysis, B at its third, six in all', async () => {
      only()
      unmatched()
      await seed(LAST)
      const trace: Start[] = []
      for (const v of [A, A, B, A, A, B, A, A, B, A, A, B]) trace.push(await startOn(v))
      expect(trace.map((t) => t.analysed)).toEqual([1, 1, 1, 1, 0, 1, 0, 0, 1, 0, 0, 0])
      // A's third analysis (start 4) records it; B's third (start 9) records B.
      expect(trace.map((t) => t.checked)).toEqual([LAST, LAST, LAST, A, A, A, A, A, B, B, B, B])
      // The panel names the installed version once it is checked; B, while
      // its analysis has not finished (starts 3 and 6), is not named yet.
      expect(trace.map((t) => t.shown)).toEqual([LAST, LAST, LAST, A, A, A, A, A, B, A, A, B])
    })

    it('real updates are still analysed: the same version again, a lower one never recorded, then a newer one', async () => {
      only()
      unmatched()
      await seed(LAST)
      const trace: Start[] = []
      for (const v of [B, B, A, B, C]) trace.push(await startOn(v))
      expect(trace.map((t) => t.analysed)).toEqual([1, 1, 1, 1, 1])
      // B recorded at its third analysis (start 4); C, newer, analysed after it.
      expect(trace.map((t) => t.checked)).toEqual([LAST, LAST, LAST, B, B])
      expect(trace.map((t) => t.shown)).toEqual([LAST, LAST, LAST, B, B])
    })

    it('a downgrade, even to a version never seen, is not analysed at start; the panel names the version installed (gate 3 F10); the next higher one is analysed from the highest version checked', async () => {
      only()
      await seed(B)
      expect(await startOn(A)).toEqual({ version: A, analysed: 0, shown: A, checked: B })
      const snap = (await sentinel()).getSentinelState()!.snapshot()
      expect(sentinelVersionParts(snap, scope)).toEqual([p === 'codex' ? `Codex ${A}` : `CC ${A}`])
      expect(sentinelCompatibleSubject(snap, scope).text).toBe(`${name} ${A}`)
      expect(await startOn(LAST)).toEqual({ version: LAST, analysed: 0, shown: LAST, checked: B })
      expect(await startOn(C)).toEqual({ version: C, analysed: 1, shown: C, checked: C })
      // The update is analysed from the highest version checked, not the one
      // shown: the notes after B up to C, nothing of B or below.
      if (p === 'codex') expect(fetchCodexReleaseNotes).toHaveBeenLastCalledWith(B, C)
      else {
        const prompt = String(claudeAnalyses().at(-1)![2])
        expect(prompt).toMatch(/- c change/)
        expect(prompt).not.toMatch(/- b change/)
      }
    })

    // Fixer 11 (ADR-009 D1 round 2, lens D finding 1) and fixer 12 (R3-1): a
    // Re-run of the lower install, the user's own act, makes it the highest
    // version checked. The higher one is then an update again at start, at
    // most UNVERIFIED_MAX_TRIES analyses, and recorded; no start re-opens it
    // after that. That cost comes only from the Re-run.
    it('two installs at the cap, then a Re-run of the lower one: the higher one is analysed again at start at most three times, then never again', async () => {
      only()
      unmatched()
      await seed(LAST)
      for (const v of [A, B, A, B, A, B]) await startOn(v)
      expect(checkedOf((await sentinel()).getSentinelState()!.snapshot())).toBe(B)
      matched()
      install(A)
      const s = await sentinel()
      const before = analyses()
      await s.sentinelRerun()
      expect(analyses() - before).toBe(1)
      expect(checkedOf(s.getSentinelState()!.snapshot())).toBe(A)
      unmatched()
      const trace: Start[] = []
      for (const v of [B, A, B, A, B, A, B, A, B, A, B, A, B, A]) trace.push(await startOn(v))
      expect(trace.map((t) => t.analysed)).toEqual([1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0])
      expect(trace.map((t) => t.checked)).toEqual([A, A, A, A, B, B, B, B, B, B, B, B, B, B])
      expect(trace.slice(4).every((t) => t.shown === t.version)).toBe(true)
    })

    // Fixer 12 (ADR-009 R3-1): a highest version checked stuck far ahead (a
    // hand-edited file, or a prerelease once installed and gone back from)
    // keeps every real update from being analysed at start; a Re-run sets it
    // to the installed version, and the next update is analysed again.
    for (const [what, stuck] of [['far ahead', '9999.0.0'], ['a prerelease far ahead', p === 'codex' ? '0.200.0-alpha.1' : '2.9.0-alpha.1']] as const) {
      it(`a highest version checked stuck ${what}: no update is analysed at start until a Re-run sets it to the installed version`, async () => {
        only()
        await sentinel(p === 'codex' ? { lastSeenCodexVersion: A, highestCheckedCodexVersion: stuck } : { lastSeenCcVersion: A, highestCheckedCcVersion: stuck })
        expect(await startOn(B)).toEqual({ version: B, analysed: 0, shown: B, checked: stuck })
        const s = await sentinel()
        const before = analyses()
        await s.sentinelRerun()
        expect(analyses() - before).toBe(1)
        expect(checkedOf(s.getSentinelState()!.snapshot())).toBe(B)
        expect(await startOn(C)).toEqual({ version: C, analysed: 1, shown: C, checked: C })
      })
    }

    // Fixer 13 (fixer 12 quality NIT 1): an unmatched analysis of a version a
    // start does not analyse (at or below the highest checked) says to Re-run
    // again; one of a version above it still says the next check analyses it.
    it('an unmatched Re-run of a version no start analyses says to Re-run again; one of a newer version says the next check', async () => {
      only()
      unmatched()
      await seed(B)
      install(A)
      let s = await sentinel()
      await s.sentinelRerun()
      let err = s.getSentinelState()!.snapshot().lastAnalysisError ?? ''
      expect(err).toBe(`One finding from the analysis of ${name} ${A} could not be matched to its ${p === 'codex' ? 'release notes' : 'changelog'}, so it is not shown. Use Re-run in the Sentinel panel to analyse it again.`)
      install(C)
      s = await sentinel()
      await s.sentinelRerun()
      err = s.getSentinelState()!.snapshot().lastAnalysisError ?? ''
      expect(err).toContain('the update will be analysed again at the next check')
      expect(err).not.toMatch(/Use Re-run/)
    })

    it('an unmatched Re-run before any version was checked says to Re-run again (the next start only takes a baseline)', async () => {
      only()
      unmatched()
      install(A)
      const s = await sentinel()
      await s.sentinelRerun()
      expect(s.getSentinelState()!.snapshot().lastAnalysisError ?? '').toMatch(/Use Re-run in the Sentinel panel to analyse it again\.$/)
    })

    it('a Re-run whose findings never match records the installed version at its third analysis, as the highest checked too', async () => {
      only()
      await sentinel(p === 'codex' ? { lastSeenCodexVersion: A, highestCheckedCodexVersion: '9999.0.0' } : { lastSeenCcVersion: A, highestCheckedCcVersion: '9999.0.0' })
      unmatched()
      install(B)
      const s = await sentinel()
      for (let i = 1; i <= 3; i++) {
        await s.sentinelRerun()
        expect(checkedOf(s.getSentinelState()!.snapshot()), `Re-run ${i}`).toBe(i < 3 ? '9999.0.0' : B)
      }
      matched()
      expect(await startOn(C)).toEqual({ version: C, analysed: 1, shown: C, checked: C })
    })

    // Fixer 11 (ADR-009 R2-1): a recorded version that is not a string (a
    // damaged or hand-edited file) no longer stops the check for good: it
    // loads as none, the next start takes the installed version as its
    // baseline, and a newer one is analysed after it.
    for (const [what, bad] of [['a number', 155], ['an object', { v: '1.0.0' }]] as const) {
      it(`a recorded version that is ${what}: the next start takes a new baseline, says nothing wrong, and a newer version is analysed`, async () => {
        only()
        await seed(bad)
        expect(await startOn(A)).toEqual({ version: A, analysed: 0, shown: A, checked: A })
        expect((await sentinel()).getSentinelState()!.snapshot().lastAnalysisError ?? null).toBeNull()
        expect(await startOn(B)).toEqual({ version: B, analysed: 1, shown: B, checked: B })
      })
    }
  })
}

// Fixer 13 (ADR-009 lens D round 3, MINOR 1): a Re-run's record sets the
// highest version checked whatever else the Re-run met: with both providers
// analysed, and with a problem carried from the other provider.
describe('fixer 13: a Re-run undoes a highest version checked stuck far ahead, with both providers on', () => {
  const STUCK = { lastSeenCcVersion: '2.1.301', highestCheckedCcVersion: '9999.0.0', lastSeenCodexVersion: '0.155.1', highestCheckedCodexVersion: '9999.0.0' }
  const changelog = '## 2.1.302\n- b change\n\n## 2.1.301\n- a change\n'
  it('both analysed in one Re-run: each provider\'s highest version checked is its installed version', async () => {
    fetchChangelog.mockImplementation(async () => changelog)
    claude.version = '2.1.302'
    svc.installation = { discoveryState: 'found', version: '0.156.0', compatibility: 'supported' }
    const s = await sentinel(STUCK)
    await s.sentinelRerun()
    expect(claudeAnalyses()).toHaveLength(2)
    expect(s.getSentinelState()!.snapshot()).toMatchObject({ highestCheckedCcVersion: '2.1.302', highestCheckedCodexVersion: '0.156.0', lastSeenCcVersion: '2.1.302', lastSeenCodexVersion: '0.156.0' })
  })

  it('Claude Code\'s version unavailable (a problem carried): Codex\'s highest version checked is still its installed version', async () => {
    fetchChangelog.mockImplementation(async () => changelog)
    claude.versionCode = 1
    svc.installation = { discoveryState: 'found', version: '0.156.0', compatibility: 'supported' }
    const s = await sentinel(STUCK)
    await s.sentinelRerun()
    const snap = s.getSentinelState()!.snapshot()
    expect(snap.lastAnalysisError).toContain('claude --version unavailable')
    expect(snap).toMatchObject({ highestCheckedCodexVersion: '0.156.0', lastSeenCodexVersion: '0.156.0', highestCheckedCcVersion: '9999.0.0' })
  })
})

describe('fixer 10: a Codex downgrade still raises its version finding', () => {
  it('a version older than the app supports, lower than the last checked: the finding, and no analysis', async () => {
    svc.pref.claude = 'off'
    const s = await sentinel({ lastSeenCodexVersion: '0.155.1' })
    svc.installation = { discoveryState: 'found', version: '0.150.0', compatibility: 'too-old' }
    await s.sentinelStartupCheck()
    expect(ids(s)).toContain('codex-version:too-old:0.150.0')
    expect(review.runs).toHaveLength(0)
    expect(fetchCodexReleaseNotes).not.toHaveBeenCalled()
    // Fixer 11: the panel names what is installed; the highest checked stays.
    expect(s.getSentinelState()!.snapshot()).toMatchObject({ lastSeenCodexVersion: '0.150.0', highestCheckedCodexVersion: '0.155.1' })
  })
})
