// [host] WP2 PR 4, P4.7 (row 68): a Codex account's Insights report, the run
// (runCodexInsights; mockup screens 1 to 9, D11 to D14, approved on the Agent
// Canvas 2026-10-05).
//
// The REAL runner and the REAL launch gate; the accounts service is scripted
// (its launch rule is proven in its own suites), and the model run is a fake
// (runCodexInsightsExec), so nothing runs. The account's sessions are real
// rollout files in a temp folder.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname, basename } from 'path'

const ACCT = `acct-${'a'.repeat(16)}`
const ACCT2 = `acct-${'b'.repeat(16)}`

const h = vi.hoisted(() => ({
  resourcesDir: '',
  sessionsDir: '',
  codex: 'on' as 'on' | 'off',
  /** Switch Codex off once the lease is held. */
  offAfterLease: false,
  prepareCalls: [] as Array<Record<string, unknown>>,
  prepareAnswer: null as null | Record<string, unknown>,
  prepareHold: null as null | Promise<void>,
  released: 0,
  execCalls: [] as Array<{ cwd: string; prompt: string; env: Record<string, string>; folderExisted: boolean; folderEntries: string[] }>,
  execHold: null as null | Promise<void>,
  execAnswer: null as null | Record<string, unknown>,
  reply: '',
}))

vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => h.resourcesDir, registerSetupHandlers: () => {} }))
vi.mock('../../../src/main/update-watcher', () => ({ getInstallPath: () => '', getProjectRootPath: () => '' }))
vi.mock('../../../src/main/profile-consumers', () => ({ acquireProfileConsumer: () => () => {}, waitForProfileRefresh: async () => {} }))
vi.mock('../../../src/main/pty-manager', () => ({ resolveClaudeForPty: () => ({ cmd: 'claude' }), withProfileHome: (env: unknown) => env }))
vi.mock('node-pty', () => ({ spawn: () => { throw new Error('no Claude PTY in a Codex run') } }))
vi.mock('../../../src/main/claude-headless', () => ({ spawnClaudeHeadless: async () => { throw new Error('no Claude run in a Codex run') } }))
vi.mock('../../../src/main/providers/codex/insights-exec', () => ({
  CODEX_INSIGHTS_TIMEOUT_MS: 600_000,
  runCodexInsightsExec: async (input: { cwd: string; prompt: string; env: Record<string, string> }) => {
    const { existsSync: ex, readdirSync: rd } = await import('fs')
    h.execCalls.push({ cwd: input.cwd, prompt: input.prompt, env: input.env, folderExisted: ex(input.cwd), folderEntries: ex(input.cwd) ? rd(input.cwd) : [] })
    if (h.execHold) await h.execHold
    return h.execAnswer ?? { ok: true, text: h.reply }
  },
}))
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({
    launchRefusal: (id: string) => id !== 'codex' || h.codex === 'on' ? null
      : { code: 'provider-off', providerId: 'codex', message: 'Codex is off. Turn it on in Settings, Accounts.' },
    snapshot: () => ({
      revision: 1, providers: [], groups: [], pendingSetups: [], externalDefaults: [], conflicts: [], reviewerNotices: [],
      identities: [{ id: 'i1', friendlyName: 'Work' }, { id: 'i2', friendlyName: '' }],
      accounts: [
        { id: ACCT, providerId: 'codex', identityId: 'i1', lifecycle: 'active', isProviderDefault: true, providerLabel: 'work@example.com', operationalState: 'ready', external: false, unverified: false },
        { id: ACCT2, providerId: 'codex', identityId: 'i2', lifecycle: 'active', isProviderDefault: false, providerLabel: 'reviewer@example.com', operationalState: 'ready', external: false, unverified: false },
      ],
    }),
    prepareLaunch: async (input: Record<string, unknown>) => {
      h.prepareCalls.push(input)
      if (h.prepareHold) await h.prepareHold
      if (h.prepareAnswer) return h.prepareAnswer
      if (h.offAfterLease) h.codex = 'off'
      return {
        ok: true, lease: { release: () => { h.released++ } }, binding: { providerAccountId: input.providerAccountId }, realmOnly: false,
        home: join(h.sessionsDir, '..'), executable: '/usr/bin/codex', env: { PATH: '/usr/bin', CODEX_HOME: join(h.sessionsDir, '..') }, sessionsDir: h.sessionsDir,
      }
    },
  }),
}))

const runner = await import('../../../src/main/insights-runner')
const { runCodexInsights, getCatalogue, getInsightsReport, getInsightsKpis, isRunning, countInsightsRunsInFlight, countCodexInsightsRunsUnleased } = runner
const { parseCodexStoredReport } = await import('../../../src/shared/insights-codex-report')
const win = () => null
let tmpRoot = ''

const REPLY = JSON.stringify({
  atAGlance: { working: 'Small edits land first time.', hindering: 'Read Only sessions stall.', quickWin: 'Start with Standard.' },
  narrative: { paragraphs: ['You use Codex for focused edits.'] },
  bigWins: [{ title: 'First-time patches', description: 'Patches applied cleanly.' }],
  friction: [], features: [], patterns: [], horizon: '',
  summary: { improvements: ['Steady.'], regressions: [], suggestions: [] },
  tasksCompletedRate: 0.8, topGoals: [{ name: 'Fix a bug', count: 2 }],
})

function rolloutLines(cwd: string, at: string): string {
  return [
    { timestamp: at, type: 'session_meta', payload: { id: 's', cwd } },
    { timestamp: at, type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: at, type: 'event_msg', payload: { type: 'user_message', message: 'Fix the bug', kind: 'plain' } },
    { timestamp: at, type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}' } },
    { timestamp: at, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Done.', duration_ms: 5000 } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n'
}
function putSession(name: string, cwd: string): void {
  const now = new Date()
  const day = join(h.sessionsDir, String(now.getFullYear()), '01', '01')
  mkdirSync(day, { recursive: true })
  writeFileSync(join(day, `rollout-${name}.jsonl`), rolloutLines(cwd, now.toISOString()))
}
const runsParent = () => join(h.resourcesDir, 'insights', '.codex-runs')
const runOf = (id: string) => getCatalogue().runs.find((r) => r.id === id)!

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ins-codex-run-'))
  h.resourcesDir = join(tmpRoot, 'resources')
  h.sessionsDir = join(tmpRoot, 'realm', 'sessions')
  mkdirSync(h.resourcesDir, { recursive: true })
  mkdirSync(h.sessionsDir, { recursive: true })
  h.codex = 'on'
  h.offAfterLease = false
  h.prepareCalls = []
  h.prepareAnswer = null
  h.prepareHold = null
  h.released = 0
  h.execCalls = []
  h.execHold = null
  h.execAnswer = null
  h.reply = REPLY
  putSession('a', join(tmpRoot, 'projects', 'one'))
  putSession('b', join(tmpRoot, 'projects', 'two'))
})
afterEach(() => { try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ } })

describe('a Codex report while Codex is off, or for something that is not a Codex account', () => {
  it('refused with the typed refusal: no record, no lock, no launch [host]', async () => {
    h.codex = 'off'
    await expect(runCodexInsights(win, { accountId: ACCT })).resolves.toEqual({ refused: { code: 'provider-off', providerId: 'codex', message: 'Codex is off. Turn it on in Settings, Accounts.' } })
    expect(getCatalogue().runs).toEqual([])
    expect(h.prepareCalls).toEqual([])
    expect(isRunning()).toBe(false)
    expect(countCodexInsightsRunsUnleased()).toBe(0)
  })

  it('a profile id, or anything but a registry account id, is refused before a record exists [host]', async () => {
    for (const bad of ['profile-abc', 'acct-xyz', '../acct', `acct-${'A'.repeat(16)}`]) {
      await expect(runCodexInsights(win, { accountId: bad })).rejects.toThrow('That is not a Codex account.')
    }
    expect(getCatalogue().runs).toEqual([])
    expect(h.prepareCalls).toEqual([])
  })
})

describe('a Codex report that completes', () => {
  it("is a run with provider 'codex' on the account; report.json and kpis.json kept; the counts are the app's [host]", async () => {
    const id = await runCodexInsights(win, { accountId: ACCT }) as string
    const run = runOf(id)
    expect(run).toMatchObject({ status: 'complete', provider: 'codex', profileId: ACCT, accountEmail: 'work@example.com' })
    expect(run.kind).toBeUndefined()
    const dir = join(h.resourcesDir, 'insights', id)
    expect(existsSync(join(dir, 'report.json'))).toBe(true)
    expect(existsSync(join(dir, 'report.html'))).toBe(false)
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'report.json')).mode & 0o777).toBe(0o600)
      expect(statSync(join(dir, 'kpis.json')).mode & 0o777).toBe(0o600)
    }
    const stored = parseCodexStoredReport(getInsightsReport(id))
    expect(stored?.title).toBe('Codex Insights')
    expect(stored?.subtitle).toMatch(/^2 turns across 2 sessions/)
    const kpis = getInsightsKpis(id) as any
    expect(kpis.kpis.Volume.sessions.value).toBe(2)
    expect(kpis.kpis.Outcomes.tasksCompleted.value).toBe(0.8)
    expect(kpis.lists['Top Tools']).toEqual([{ name: 'shell', count: 2 }])
  })

  it("launches on the account's own lease (kind background, this computer), names it, and lets go after [host]", async () => {
    await runCodexInsights(win, { accountId: ACCT })
    expect(h.prepareCalls).toHaveLength(1)
    expect(h.prepareCalls[0]).toMatchObject({ kind: 'background', providerId: 'codex', providerAccountId: ACCT, remote: false })
    expect(h.prepareCalls[0]).not.toHaveProperty('acknowledgeRealmOnly')
    expect(h.released).toBe(1)
  })

  it('runs in a fresh empty folder made for it under the runs folder (a .git marker only), removed after; material on stdin [host]', async () => {
    await runCodexInsights(win, { accountId: ACCT })
    expect(h.execCalls).toHaveLength(1)
    const call = h.execCalls[0]
    expect(dirname(call.cwd)).toBe(runsParent())
    expect(basename(call.cwd).startsWith('ccc-insights-codex-')).toBe(true)
    expect(call.folderExisted).toBe(true)
    expect(call.folderEntries).toEqual(['.git'])
    expect(existsSync(call.cwd)).toBe(false)
    expect(call.env.GIT_CEILING_DIRECTORIES).toBe(runsParent())
    expect(call.prompt).toContain('Sessions: 2')
    expect(call.prompt).toContain('Fix the bug')
  })

  it("the report's own earlier runs are left out of its counts (D13) [host]", async () => {
    putSession('own', join(runsParent(), 'ccc-insights-codex-old1'))
    const id = await runCodexInsights(win, { accountId: ACCT }) as string
    expect((getInsightsKpis(id) as any).kpis.Volume.sessions.value).toBe(2)
  })

  it("'vs previous run' pairs runs by account AND assistant: the second report gets the first's figures, never another assistant's run [host]", async () => {
    // A Claude Code run recorded on the same id (impossible in practice; it
    // proves the pairing reads the assistant).
    const claudeId = '2020-01-01-000000-000000'
    mkdirSync(join(h.resourcesDir, 'insights', claudeId), { recursive: true })
    writeFileSync(join(h.resourcesDir, 'insights', claudeId, 'kpis.json'), '{"claudeMarker":true}')
    writeFileSync(join(h.resourcesDir, 'insights', 'catalogue.json'), JSON.stringify({ runs: [{ id: claudeId, timestamp: 1, status: 'complete', profileId: ACCT }] }))
    await runCodexInsights(win, { accountId: ACCT })
    expect(h.execCalls[0].prompt).toContain('There is no previous run to compare against.')
    expect(h.execCalls[0].prompt).not.toContain('claudeMarker')
    await runCodexInsights(win, { accountId: ACCT })
    expect(h.execCalls[1].prompt).toContain("PREVIOUS RUN'S FIGURES")
    expect(h.execCalls[1].prompt).toContain('"tasksCompleted"')
    // Another Codex account's run is not this one's previous run.
    await runCodexInsights(win, { accountId: ACCT2 })
    expect(h.execCalls[2].prompt).toContain('There is no previous run to compare against.')
  })
})

describe('a Codex report that does not complete', () => {
  it("a reply that fails the check fails the whole run, with its reason; nothing is kept (D14) [host]", async () => {
    h.reply = JSON.stringify({ atAGlance: { working: 'only one' } })
    const id = await runCodexInsights(win, { accountId: ACCT }) as string
    const run = runOf(id)
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/^Codex's reply was not a report the page can show, so nothing was kept\. Try New run again\. \(.*atAGlance/)
    expect(run.kpisUnavailable).toBeUndefined()
    expect(existsSync(join(h.resourcesDir, 'insights', id, 'report.json'))).toBe(false)
    expect(existsSync(join(h.resourcesDir, 'insights', id, 'kpis.json'))).toBe(false)
    expect(h.released).toBe(1)
  })

  it('a model run that fails says why; the lease and the folder go [host]', async () => {
    h.execAnswer = { ok: false, code: 'failed', message: 'Codex exited with code 1: usage limit reached.' }
    const id = await runCodexInsights(win, { accountId: ACCT }) as string
    expect(runOf(id)).toMatchObject({ status: 'failed', error: 'This report could not be written: Codex exited with code 1: usage limit reached.' })
    expect(h.released).toBe(1)
    expect(readdirSync(runsParent())).toEqual([])
  })

  it('no sessions in the window: failed with a plain reason, and no model run [host]', async () => {
    rmSync(h.sessionsDir, { recursive: true, force: true })
    const id = await runCodexInsights(win, { accountId: ACCT }) as string
    expect(runOf(id)).toMatchObject({ status: 'failed', error: 'This account has no Codex sessions from the last 30 days to report on.' })
    expect(h.execCalls).toEqual([])
  })

  it('a sign-in that has lapsed: failed, flagged for the sign-in banner (D10) [host]', async () => {
    h.prepareAnswer = { ok: false, code: 'not-signed-in', message: 'This account is not signed in.' }
    const id = await runCodexInsights(win, { accountId: ACCT }) as string
    expect(runOf(id)).toMatchObject({ status: 'failed', authFailed: true, error: 'This report could not start: This account is not signed in.' })
    expect(h.execCalls).toEqual([])
    h.prepareAnswer = { ok: false, code: 'busy', message: 'Something else is using this account.' }
    const id2 = await runCodexInsights(win, { accountId: ACCT }) as string
    expect(runOf(id2).authFailed).toBeUndefined()
  })

  it('Codex switched off once the lease is held: not started, says why, lets go [host]', async () => {
    h.offAfterLease = true
    const id = await runCodexInsights(win, { accountId: ACCT }) as string
    expect(runOf(id)).toMatchObject({ status: 'failed', error: 'Codex is off. Turn it on in Settings, Accounts.' })
    expect(h.execCalls).toEqual([])
    expect(h.released).toBe(1)
  })
})

describe("the per-run confirmation (D12)", () => {
  it('is sent with the account it names, and only when given [host]', async () => {
    await runCodexInsights(win, { accountId: ACCT, acknowledgeRealmOnly: true })
    expect(h.prepareCalls[0]).toMatchObject({ providerAccountId: ACCT, acknowledgeRealmOnly: true })
  })

  it("an account main says needs it, run without it: failed with main's reason, nothing run [host]", async () => {
    h.prepareAnswer = { ok: false, code: 'acknowledgement-required', message: 'This sign-in is unverified: confirm that this launch may use it.' }
    const id = await runCodexInsights(win, { accountId: ACCT }) as string
    expect(runOf(id)).toMatchObject({ status: 'failed', error: 'This report could not start: This sign-in is unverified: confirm that this launch may use it.' })
    expect(h.execCalls).toEqual([])
  })
})

describe('a Codex report is Codex in use, never Claude Code in use (D11, screen 8)', () => {
  it('counted unleased from the launch check until the lease is held, then through the lease; never as Claude Code [host]', async () => {
    let letPrepare!: () => void
    let letExec!: () => void
    h.prepareHold = new Promise<void>((r) => { letPrepare = r })
    h.execHold = new Promise<void>((r) => { letExec = r })
    const pending = runCodexInsights(win, { accountId: ACCT })
    // Counted in the same step as the check: before any await.
    expect(countCodexInsightsRunsUnleased()).toBe(1)
    expect(countInsightsRunsInFlight()).toBe(0)
    expect(isRunning(ACCT)).toBe(true)
    await vi.waitFor(() => expect(h.prepareCalls).toHaveLength(1))
    expect(countCodexInsightsRunsUnleased()).toBe(1)
    letPrepare()
    await vi.waitFor(() => expect(h.execCalls).toHaveLength(1))
    // The lease holds it now (provider-in-use counts leases for Codex).
    expect(countCodexInsightsRunsUnleased()).toBe(0)
    expect(h.released).toBe(0)
    letExec()
    await pending
    expect(countCodexInsightsRunsUnleased()).toBe(0)
    expect(isRunning()).toBe(false)
    expect(h.released).toBe(1)
  })

  it('one report per account at a time; another account runs alongside [host]', async () => {
    let letExec!: () => void
    h.execHold = new Promise<void>((r) => { letExec = r })
    const first = runCodexInsights(win, { accountId: ACCT })
    await expect(runCodexInsights(win, { accountId: ACCT })).rejects.toThrow('Insights already running for this account')
    const other = runCodexInsights(win, { accountId: ACCT2 })
    letExec()
    await Promise.all([first, other])
    expect(getCatalogue().runs.filter((r) => r.status === 'complete')).toHaveLength(2)
  })

  it('a refused run is not counted [host]', async () => {
    h.codex = 'off'
    await runCodexInsights(win, { accountId: ACCT })
    expect(countCodexInsightsRunsUnleased()).toBe(0)
  })
})

describe("the report is handed to the page as data, never as a report.html (D2)", () => {
  it("a Codex run's report is its report.json; a stray report.html beside it is never read [host]", async () => {
    const id = await runCodexInsights(win, { accountId: ACCT }) as string
    writeFileSync(join(h.resourcesDir, 'insights', id, 'report.html'), '<script>alert(1)</script>')
    const text = getInsightsReport(id)!
    expect(text).not.toContain('<script>')
    expect(JSON.parse(text).version).toBe(1)
  })
})
