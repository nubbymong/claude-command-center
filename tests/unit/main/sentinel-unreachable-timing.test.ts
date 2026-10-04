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
 *    Its first failed request is reported 5.8 s in; with 3 retries it gave
 *    up after 9.9 s and with 5 after 23.0 s (its backoff doubles from 0.5 s).
 * The fakes below replay those measurements on a virtual clock (each fake
 * adds the time the real step took), so a test reads how long the panel
 * waited without waiting itself. The Codex reviewer is replayed as the
 * handed reviewer change makes it: it ends an analysis run once Codex says
 * it is waiting for the network. The Claude Code run is replayed as the
 * stream the analysis reads (owner answers review): an `api_retry` line before
 * each retry, its `error_status` null when no answer came back (the pinned
 * 2.1.288 CLI's `--output-format stream-json --verbose`), so Sentinel ends it
 * after five such retries in a row, and an answered retry keeps its schedule.
 * A Claude Code that prints no retry line (the VM run checks 2.1.278) is replayed too:
 * the analysis's retry backstop (8) makes it give its own reason inside the
 * 180 s deadline, an estimate, as no such run was measured.
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

/** `claude -p` with Sentinel's argv against a service it cannot reach: the
 *  seconds until it gives its own reason, by the retries it is allowed. VM:
 *  the default 10 gave up after 192.7 s. 8 is an ESTIMATE (unmeasured): 95.5 s
 *  of backoff, about 120 s with the CLI's 25% jitter, plus about 3 s for each
 *  of 9 refused requests (what the VM's 192.7 s for 10 retries implies). */
const CLAUDE_GIVES_UP_S: Record<string, number> = { default: 192.7, '8': 150 }
/** When it reports each failed request, in seconds after the run started:
 *  the first at 5.8 s, then its backoff doubling from 0.5 s. */
const CLAUDE_RETRY_REPORT_S = [5.8, 6.3, 7.3, 9.3, 13.3, 21.3, 37.3, 69.3, 101.3, 133.3]
/** The reason it gives once its retries run out (the CLI's own words). */
const CLAUDE_UNREACHABLE = 'API Error: Connection refused \u2014 a firewall or proxy may be blocking it (ECONNREFUSED)'
const claudeMode = vi.hoisted(() => ({ analysis: 'unreachable' as 'unreachable' | 'ok' | 'overloaded' | 'silent' }))
const claudeAnalyses: Array<{ args: string[]; env?: Record<string, string>; stopped: boolean; retries: number }> = []
type HeadlessOpts = { env?: Record<string, string>; onStdout?: (chunk: string) => void }
const spawnClaudeHeadless = vi.fn(async (args: string[], timeoutMs?: number, _stdin?: string, _home?: string | null, signal?: AbortSignal, opts?: HeadlessOpts) => {
  if (args[0] === '--version') { clock.t += 5.8; return { code: 0, stdout: '2.1.300 (Claude Code)', stderr: '' } }
  const run = { args, env: opts?.env, stopped: false, retries: 0 }
  claudeAnalyses.push(run)
  const start = clock.t
  let stdout = ''
  const emit = (ev: Record<string, unknown>) => { const l = JSON.stringify(ev) + '\n'; stdout += l; opts?.onStdout?.(l) }
  const reply = () => {
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify({ breakingChanges: [] }) }] } })
    emit({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify({ breakingChanges: [] }) })
    return { code: 0, stdout, stderr: '' }
  }
  emit({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] })
  if (claudeMode.analysis === 'ok') { clock.t += 15; return reply() }
  const deadline = (timeoutMs ?? 180000) / 1000
  const answered = claudeMode.analysis === 'overloaded'
  const allowed = opts?.env?.CLAUDE_CODE_MAX_RETRIES
  const givesUp = CLAUDE_GIVES_UP_S[allowed ?? 'default'] ?? CLAUDE_GIVES_UP_S.default
  // An overloaded service answers 529 three times (about 9 s of backoff), then serves the reply.
  // An older Claude Code ('silent') prints no retry line at all.
  const reports = claudeMode.analysis === 'silent' ? [] : CLAUDE_RETRY_REPORT_S.slice(0, answered ? 4 : allowed ? Number(allowed) : undefined)
  for (const [i, at] of reports.entries()) {
    if (at > deadline) break
    clock.t = start + at
    if (answered && i === 3) return reply()
    emit({ type: 'system', subtype: 'api_retry', attempt: i + 1, max_retries: 10, retry_delay_ms: 500 * 2 ** i, error_status: answered ? 529 : null, error: answered ? 'overloaded' : 'unknown' })
    run.retries++
    if (signal?.aborted) { run.stopped = true; return { code: 1, stdout, stderr: '\nAborted' } }
  }
  if (givesUp > deadline) { clock.t = start + deadline; return { code: 1, stdout, stderr: `\nTimed out after ${deadline}s` } }
  clock.t = start + givesUp
  emit({ type: 'result', subtype: 'success', is_error: true, result: CLAUDE_UNREACHABLE })
  return { code: 1, stdout, stderr: '' }
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
  it('Claude Code: the run ends after five retries in a row with no answer, and is not tried again (VM: 6 min before, two 180 s deadlines) [host]', async () => {
    pref.claude = 'on'; pref.codex = 'off'
    const { mod, report } = await sentinelSeeded({ lastSeenCcVersion: '2.1.290' })
    await mod.sentinelStartupCheck()
    expect(report.at).not.toBeNull()
    expect(report.at!).toBeLessThanOrEqual(MINUTE)
    expect(claudeAnalyses).toHaveLength(1)
    expect(claudeAnalyses[0]).toMatchObject({ stopped: true, retries: 5 })
    expect(claudeAnalyses[0].args).toEqual(expect.arrayContaining(['--output-format', 'stream-json', '--verbose']))
    expect(claudeAnalyses[0].env?.CLAUDE_CODE_MAX_RETRIES).toBe('8')
    expect(report.error).toMatch(/could not reach its service/i)
    expect(report.error).toMatch(/no answer/)
    expect(report.error).toMatch(/Re-run/)
  })

  it('a Claude Code that prints no retry line: the retry backstop ends it with the CLI\'s own reason inside the deadline, one attempt [host]', async () => {
    pref.claude = 'on'; pref.codex = 'off'
    claudeMode.analysis = 'silent'
    const { mod, report } = await sentinelSeeded({ lastSeenCcVersion: '2.1.290' })
    await mod.sentinelStartupCheck()
    expect(claudeAnalyses).toHaveLength(1)
    expect(claudeAnalyses[0]).toMatchObject({ stopped: false, retries: 0 })
    expect(report.at).not.toBeNull()
    expect(report.at!).toBeLessThan(180)
    expect(report.error).toMatch(/could not reach its service/i)
    expect(report.error).toContain('ECONNREFUSED')
    expect(report.error).not.toMatch(/busy or rate limited|update was large/)
  })

  it('Claude Code: an overloaded service that answers keeps Claude Code\'s own retries, and the analysis completes [host]', async () => {
    pref.claude = 'on'; pref.codex = 'off'
    claudeMode.analysis = 'overloaded'
    const { mod, report } = await sentinelSeeded({ lastSeenCcVersion: '2.1.290' })
    await mod.sentinelStartupCheck()
    expect(claudeAnalyses).toHaveLength(1)
    expect(claudeAnalyses[0]).toMatchObject({ stopped: false, retries: 3 })
    expect(report.error).toBeNull()
    expect(mod.getSentinelState()!.snapshot().lastSeenCcVersion).toBe('2.1.300')
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
