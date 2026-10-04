/**
 * PR 4 (owner answers, the Sentinel chase): how long the Sentinel panel says
 * "analyzing" when the analysis cannot reach its assistant's service, or when
 * the release notes cannot be read, through the REAL Sentinel service. [host]
 *
 * Measured on the Windows test VM (2026-10-04, every proxy a dead loopback
 * port, as the earlier VM run that sat on "analyzing"): the notes WERE read
 * (13 requests, 2.9 s); the time went to the analysis agent, which never
 * reached its model and was given a second attempt:
 *  - Codex 0.153.4 and 0.155.1: `codex exec` reconnects five times over
 *    WebSockets (15.5 s), falls back to HTTPS, and from 33.8 s says
 *    "Reconnecting... waiting for network" without end, so it ran into the
 *    180 s deadline, twice: 6 min 05 s.
 *  - Claude Code: `claude -p` retries 10 times and gives up after 192.7 s,
 *    past the 180 s deadline, so it too was killed and tried again: 6 min.
 *    With CLAUDE_CODE_MAX_RETRIES=5 it gives its own reason after 23.0 s.
 * The fakes below replay those measurements on a virtual clock (each fake
 * adds the time the real step took), so a test reads how long the panel
 * waited without waiting itself. The Codex reviewer is replayed as the
 * handed reviewer change makes it: it ends an analysis run once Codex says
 * it is waiting for the network.
 *
 * The owner's bar: the panel reports within a minute, with what happened.
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

/** The virtual clock, in seconds since the check began. */
const clock = vi.hoisted(() => ({ t: 0 }))
const pref = vi.hoisted(() => ({ claude: 'on', codex: 'off' } as Record<string, 'on' | 'off'>))
const refusal = (id: string) => pref[id] === 'off'
  ? { code: 'provider-off', providerId: id, message: `${id === 'codex' ? 'Codex' : 'Claude Code'} is off. Turn it on in Settings, Accounts.` }
  : null
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({
    launchRefusal: (id: string) => refusal(id),
    discover: async (id: string) => (refusal(id) ? { ok: false, code: 'provider-disabled', message: 'off' } : { ok: true, installation: { providerId: id, discoveryState: 'found', version: '0.155.1', compatibility: 'supported' } }),
    readModelCatalogue: async () => ({ ok: true, catalogue: { ok: false, code: 'failed', detail: 'x' } }),
    prepareLaunch: async () => ({
      ok: true, lease: { release: () => {} }, binding: { providerAccountId: 'acct-work', authRealmId: 'realm-1' }, realmOnly: false,
      home: 'C:\\realms\\realm-1', executable: 'C:\\Tools\\codex.exe', env: { CODEX_HOME: 'C:\\realms\\realm-1' }, sessionsDir: 'C:\\realms\\realm-1\\sessions',
    }),
    snapshot: () => ({
      providers: [{ providerId: 'codex', discoveryState: 'found', version: '0.155.1', compatibility: 'supported' }],
      accounts: [{ id: 'acct-work', identityId: 'id-1', providerLabel: 'work@example.com' }],
      identities: [{ id: 'id-1', friendlyName: 'Work' }],
    }),
  }),
}))

/** What the Codex reviewer answers for an analysis, and when. */
const codexRuns = vi.hoisted(() => ({ n: 0, mode: 'unreachable' as 'unreachable' | 'ok' }))
/** VM: the first "waiting for network" event, 33.8 s after the run started. */
const CODEX_WAITING_FOR_NETWORK_S = 33.8
vi.mock('../../../src/main/providers/core', async (orig) => {
  // The reviewer's own words, from the one place they are written.
  const { CODEX_UNREACHABLE_PREFIX } = await import('../../../src/main/providers/codex/review')
  return {
    ...(await orig<typeof import('../../../src/main/providers/core')>()),
    tryGetProviderPackage: (id: string) => id !== 'codex' ? null : {
      id, displayName: 'Codex',
      setup: { supportedVersions: { minimum: '0.153.4', maximumTested: '0.156.1' } },
      review: {
        run: async (input: { timeoutMs: number }) => {
          codexRuns.n++
          if (codexRuns.mode === 'ok') { clock.t += 20; return { ok: true, text: JSON.stringify({ breakingChanges: [] }) } }
          clock.t += Math.min(CODEX_WAITING_FOR_NETWORK_S, input.timeoutMs / 1000)
          return { ok: false, code: 'failed', message: `${CODEX_UNREACHABLE_PREFIX}: Reconnecting... waiting for network (Connection failed: error sending request).` }
        },
      },
    },
  }
})
vi.mock('../../../src/main/config-manager', () => ({
  readConfig: () => null,
  readConfigChecked: () => ({ value: null, outcome: 'absent' }),
}))
vi.mock('../../../src/main/account-profiles', () => ({
  resolveHeadlessProfileHome: () => ({ home: null, profileId: null }),
  listProfiles: () => [],
  sharedRoot: () => path.join(os.tmpdir(), 'ccc-sentinel-timing-no-such-folder'),
}))

/** VM: `claude -p` with Sentinel's argv against a service it cannot reach,
 *  by the retries it was allowed: the seconds until it gave its reason. */
const CLAUDE_GIVES_UP_S: Record<string, number> = { default: 192.7, '5': 23.0, '3': 9.9, '0': 5.8 }
/** The reason it gave, each time (the CLI's own words). */
const CLAUDE_UNREACHABLE = 'API Error: Connection refused \u2014 a firewall or proxy may be blocking it (ECONNREFUSED)'
const claudeMode = vi.hoisted(() => ({ analysis: 'unreachable' as 'unreachable' | 'ok' }))
const claudeAnalyses: Array<{ env?: Record<string, string> }> = []
const spawnClaudeHeadless = vi.fn(async (args: string[], timeoutMs?: number, _stdin?: string, _home?: string | null, _signal?: AbortSignal, opts?: { env?: Record<string, string> }) => {
  if (args[0] === '--version') { clock.t += 5.8; return { code: 0, stdout: '2.1.300 (Claude Code)', stderr: '' } }
  claudeAnalyses.push({ env: opts?.env })
  if (claudeMode.analysis === 'ok') { clock.t += 15; return { code: 0, stdout: JSON.stringify({ type: 'result', result: JSON.stringify({ breakingChanges: [] }) }), stderr: '' } }
  const retries = opts?.env?.CLAUDE_CODE_MAX_RETRIES ?? 'default'
  const givesUp = CLAUDE_GIVES_UP_S[retries] ?? CLAUDE_GIVES_UP_S.default
  const deadline = (timeoutMs ?? 180000) / 1000
  if (givesUp > deadline) { clock.t += deadline; return { code: 1, stdout: '', stderr: `\nTimed out after ${deadline}s` } }
  clock.t += givesUp
  return { code: 1, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: CLAUDE_UNREACHABLE }), stderr: '' }
})
vi.mock('../../../src/main/claude-headless', () => ({ spawnClaudeHeadless: (...a: unknown[]) => spawnClaudeHeadless(...(a as [string[], number, string])) }))
vi.mock('../../../src/main/sentinel/sentinel-model-article', () => ({ fetchArticleModelIds: async () => { clock.t += 0.6; return null } }))
const notes = vi.hoisted(() => ({ readable: true }))
const CHANGELOG = '# Changelog\n\n## 2.1.300\n- Something changed in the statusline hook payload.\n\n## 2.1.299\n- Older fixes.\n'
vi.mock('../../../src/main/sentinel/sentinel-changelog', async (orig) => {
  const real = await orig<typeof import('../../../src/main/sentinel/sentinel-changelog')>()
  return {
    ...real,
    // Unreadable: the read's overall deadline (CHANGELOG_DEADLINE_MS, 20 s) is
    // the longest it waits; the socket's 10 s idle limit can only end it sooner.
    fetchChangelog: async () => { if (!notes.readable) { clock.t += real.CHANGELOG_DEADLINE_MS / 1000; return null } clock.t += 1; return CHANGELOG },
  }
})
vi.mock('../../../src/main/sentinel/sentinel-codex-changelog', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/sentinel/sentinel-codex-changelog')>()),
  // VM: 13 requests in 2.9 s; unreadable: the first request's deadline (10 s) ends the read.
  fetchCodexReleaseNotes: async () => {
    if (!notes.readable) { clock.t += 10; return null }
    clock.t += 2.9
    return { text: '## 0.155.1\n- The rollout file format changed.', versions: ['0.155.1'], cut: null }
  },
}))

const PREFIX = 'ccc-sentinel-timing-'
let dir = ''
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX))
  clock.t = 0
  codexRuns.n = 0
  codexRuns.mode = 'unreachable'
  claudeMode.analysis = 'unreachable'
  claudeAnalyses.length = 0
  notes.readable = true
  spawnClaudeHeadless.mockClear()
})
afterEach(() => {
  // TEST CLEANUP GUARD: only this suite's own state folder, by its prefix and parent.
  if (path.basename(dir).startsWith(PREFIX) && path.dirname(dir) === os.tmpdir()) fs.rmSync(dir, { recursive: true, force: true })
})

/** The real service on this suite's folder, seeded with the versions last
 *  checked, so the installed ones are an update at start. The second value
 *  is when (virtual seconds) the panel first stopped saying "analyzing" and
 *  what it said. */
async function sentinelSeeded(seed: Record<string, unknown>) {
  fs.mkdirSync(path.join(dir, 'sentinel'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'sentinel', 'sentinel-state.json'), JSON.stringify({ lastSeenCcVersion: null, analyzing: false, lastAnalysisAt: null, lastAnalysisError: null, findings: [], ...seed }))
  const { _initRegistryForTest } = await import('../../../src/main/model-registry-service')
  _initRegistryForTest(dir)
  const mod = await import('../../../src/main/sentinel/index')
  const state = mod.initSentinel(dir)
  const report = { startedAt: null as number | null, at: null as number | null, error: null as string | null }
  state.subscribe((s) => {
    if (s.analyzing && report.startedAt === null) report.startedAt = clock.t
    if (!s.analyzing && report.startedAt !== null && report.at === null) { report.at = clock.t; report.error = s.lastAnalysisError }
  })
  return { mod, report }
}

const MINUTE = 60

describe('the analysis cannot reach its service: the panel reports within a minute, saying so', () => {
  it('Claude Code: one bounded attempt with the CLI\'s own reason (VM: 6 min before, two 180 s deadlines) [host]', async () => {
    pref.claude = 'on'; pref.codex = 'off'
    const { mod, report } = await sentinelSeeded({ lastSeenCcVersion: '2.1.290' })
    await mod.sentinelStartupCheck()
    expect(report.at).not.toBeNull()
    expect(report.at!).toBeLessThanOrEqual(MINUTE)
    expect(claudeAnalyses).toHaveLength(1)
    expect(claudeAnalyses[0].env?.CLAUDE_CODE_MAX_RETRIES).toBe('5')
    expect(report.error).toMatch(/could not reach/i)
    expect(report.error).toContain('ECONNREFUSED')
    expect(report.error).toMatch(/Re-run/)
  })

  it('Codex: the run ends when Codex waits for the network, and is not tried again (VM: 6 min 05 s before) [host]', async () => {
    pref.claude = 'off'; pref.codex = 'on'
    const { mod, report } = await sentinelSeeded({ lastSeenCodexVersion: '0.150.0', highestCheckedCodexVersion: '0.150.0' })
    await mod.sentinelStartupCheck()
    expect(report.at).not.toBeNull()
    expect(report.at!).toBeLessThanOrEqual(MINUTE)
    expect(codexRuns.n).toBe(1)
    expect(report.error).toMatch(/could not reach its model/i)
    expect(report.error).toMatch(/Re-run/)
  })

  it('a Re-run is bounded the same way [host]', async () => {
    pref.claude = 'on'; pref.codex = 'off'
    const { mod, report } = await sentinelSeeded({ lastSeenCcVersion: '2.1.300' })
    clock.t = 0
    await mod.sentinelRerun()
    expect(report.at).not.toBeNull()
    expect(report.at!).toBeLessThanOrEqual(MINUTE)
    expect(claudeAnalyses).toHaveLength(1)
  })
})

describe('the release notes cannot be read: the panel says so within a minute (guard) [host]', () => {
  it('Claude Code: "changelog unavailable", no analysis', async () => {
    pref.claude = 'on'; pref.codex = 'off'
    notes.readable = false
    const { mod, report } = await sentinelSeeded({ lastSeenCcVersion: '2.1.290' })
    await mod.sentinelStartupCheck()
    expect(report.at!).toBeLessThanOrEqual(MINUTE)
    expect(report.error).toMatch(/Changelog unavailable/)
    expect(claudeAnalyses).toHaveLength(0)
  })

  it('Codex: "could not be read from GitHub", no analysis', async () => {
    pref.claude = 'off'; pref.codex = 'on'
    notes.readable = false
    const { mod, report } = await sentinelSeeded({ lastSeenCodexVersion: '0.150.0', highestCheckedCodexVersion: '0.150.0' })
    await mod.sentinelStartupCheck()
    expect(report.at!).toBeLessThanOrEqual(MINUTE)
    expect(report.error).toMatch(/could not be read from GitHub/)
    expect(codexRuns.n).toBe(0)
  })
})

describe('everything reachable: nothing changes (guard) [host]', () => {
  it('Claude Code: one analysis, no error, the version recorded', async () => {
    pref.claude = 'on'; pref.codex = 'off'
    claudeMode.analysis = 'ok'
    const { mod, report } = await sentinelSeeded({ lastSeenCcVersion: '2.1.290' })
    await mod.sentinelStartupCheck()
    expect(claudeAnalyses).toHaveLength(1)
    expect(report.error).toBeNull()
    expect(mod.getSentinelState()!.snapshot().lastSeenCcVersion).toBe('2.1.300')
  })

  it('Codex: one analysis, no error, the version recorded', async () => {
    pref.claude = 'off'; pref.codex = 'on'
    codexRuns.mode = 'ok'
    const { mod, report } = await sentinelSeeded({ lastSeenCodexVersion: '0.150.0', highestCheckedCodexVersion: '0.150.0' })
    await mod.sentinelStartupCheck()
    expect(codexRuns.n).toBe(1)
    expect(report.error).toBeNull()
    expect(mod.getSentinelState()!.snapshot().lastSeenCodexVersion).toBe('0.155.1')
  })
})
