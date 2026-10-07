// HOST QUARANTINE: plants junctions (directory links). [CI] [VM] only -- never run on the owner's machine.
/**
 * P3.9 round 1 and 2: the folders Sentinel's analyses run in, through the REAL
 * Sentinel service, where the runs folder is (or becomes) a link: a runs folder
 * that is a link, or became one between the check and the make, is refused,
 * nothing runs and nothing is written through it; the sweep of earlier runs'
 * leftovers never follows a link. Moved here from sentinel-codex-service.test.ts
 * (PR 4, owner answers review), which keeps the host-safe cases, with the same
 * fakes: no process starts, no request leaves, and the only folders made are
 * this suite's own state folder and what the service makes inside it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

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
const runsDir = () => path.join(dir, 'sentinel', 'runs')

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
