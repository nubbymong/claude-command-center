// [host] WP2 PR 4, P4.7 (row 68), mockup choice C1 = A (approved on the Agent
// Canvas 2026-10-05): Run all makes ONE roll-up over every account of both
// assistants that is on. An account marked "confirm at launch" is named under
// "Left out of this comparison", never run (D12). The written analysis runs
// where it runs today (the primary when it produced figures, else the first
// member that did); on a Codex account, or with Claude Code off, Codex writes
// it. The roll-up's own rules are unchanged.
//
// The REAL runner and launch gate; Claude Code's PTY and headless runs, the
// accounts service and the Codex model run are fakes, so nothing runs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ACCT = `acct-${'a'.repeat(16)}`
const ACCT2 = `acct-${'b'.repeat(16)}`
const EXT = `acct-${'c'.repeat(16)}`

const h = vi.hoisted(() => ({
  resourcesDir: '',
  sessionsDir: '',
  claude: 'on' as 'on' | 'off',
  codex: 'on' as 'on' | 'off',
  /** Claude Code's KPI pass fails, so its members produce no figures. */
  claudeKpiFails: false,
  profileDir: {} as Record<string, string>,
  profiles: [] as Array<{ id: string; accountEmail: string; isPrimary?: boolean; name?: string }>,
  prepareCalls: [] as Array<Record<string, unknown>>,
  execPrompts: [] as string[],
  claudePrompts: [] as string[],
  codexInUseDuringExec: [] as number[],
  claudeInUseDuringExec: [] as number[],
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
vi.mock('../../../src/main/profile-consumers', () => ({ acquireProfileConsumer: () => () => {}, waitForProfileRefresh: async () => {} }))
vi.mock('../../../src/main/pty-manager', () => ({ resolveClaudeForPty: () => ({ cmd: 'claude' }), withProfileHome: (env: unknown) => env }))
vi.mock('node-pty', () => ({
  spawn: () => ({ onData: () => {}, onExit: (cb: (e: { exitCode: number }) => void) => { queueMicrotask(() => cb({ exitCode: 0 })) }, write: () => {}, kill: () => {} }),
}))
const CLAUDE_KPIS = JSON.stringify({
  period: { start: '2026-09-10', end: '2026-10-01', days: 14 },
  kpis: { Volume: { sessions: { value: 41, label: 'Sessions', format: 'number', goodDirection: 'up' } } },
})
vi.mock('../../../src/main/claude-headless', () => ({
  spawnClaudeHeadless: async (args: string[], _t: number, prompt: string) => {
    if (args.includes('--allowedTools')) return h.claudeKpiFails ? { code: 1, stdout: '', stderr: 'boom' } : { code: 0, stdout: CLAUDE_KPIS, stderr: '' }
    h.claudePrompts.push(prompt)
    return { code: 0, stdout: JSON.stringify({ summary: { improvements: ['steady'] }, accounts: [], crossAccount: { observations: ['Claude wrote this'] } }), stderr: '' }
  },
}))
const REPORT_REPLY = JSON.stringify({
  atAGlance: { working: 'a', hindering: 'b', quickWin: 'c' },
  narrative: { paragraphs: ['p'] },
  bigWins: [], friction: [], features: [], patterns: [], horizon: '',
  summary: { improvements: [], regressions: [], suggestions: [] },
  tasksCompletedRate: 0.7,
})
vi.mock('../../../src/main/providers/codex/insights-exec', () => ({
  CODEX_INSIGHTS_TIMEOUT_MS: 600_000,
  runCodexInsightsExec: async (input: { prompt: string }) => {
    const r = await import('../../../src/main/insights-runner')
    h.execPrompts.push(input.prompt)
    h.codexInUseDuringExec.push(r.countCodexInsightsRunsUnleased())
    h.claudeInUseDuringExec.push(r.countInsightsRunsInFlight())
    if (input.prompt.startsWith('You are comparing')) {
      return { ok: true, text: JSON.stringify({ summary: { improvements: ['both fine'] }, accounts: [], crossAccount: { observations: ['Codex wrote this'] } }) }
    }
    return { ok: true, text: REPORT_REPLY }
  },
}))
const codexAccount = (id: string, identityId: string, over: Record<string, unknown> = {}) => ({
  id, providerId: 'codex', identityId, lifecycle: 'active', isProviderDefault: false, providerLabel: `${identityId}@example.com`,
  operationalState: 'ready', external: false, unverified: false, ...over,
})
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({
    launchRefusal: (id: string) => {
      const on = id === 'claude' ? h.claude === 'on' : h.codex === 'on'
      return on ? null : { code: 'provider-off', providerId: id, message: `${id === 'claude' ? 'Claude Code' : 'Codex'} is off. Turn it on in Settings, Accounts.` }
    },
    snapshot: () => ({
      revision: 1, providers: [], groups: [], pendingSetups: [], externalDefaults: [], conflicts: [], reviewerNotices: [],
      identities: [{ id: 'work', friendlyName: 'Work' }, { id: 'rev', friendlyName: 'Reviewer' }, { id: 'ext', friendlyName: '' }],
      accounts: [
        codexAccount(ACCT, 'work', { isProviderDefault: true }),
        codexAccount(ACCT2, 'rev'),
        codexAccount(EXT, 'ext', { external: true }),
        codexAccount(`acct-${'d'.repeat(16)}`, 'rev', { operationalState: 'blocked' }),
        codexAccount(`acct-${'e'.repeat(16)}`, 'rev', { lifecycle: 'archived' }),
      ],
    }),
    prepareLaunch: async (input: Record<string, unknown>) => {
      h.prepareCalls.push(input)
      return {
        ok: true, lease: { release: () => {} }, binding: { providerAccountId: input.providerAccountId }, realmOnly: false,
        home: join(h.sessionsDir, '..'), executable: '/usr/bin/codex', env: { PATH: '/usr/bin' }, sessionsDir: h.sessionsDir,
      }
    },
  }),
}))

const { runCrossAccountInsights, getCatalogue, getInsightsKpis, countCodexInsightsRunsUnleased, countInsightsRunsInFlight, CODEX_NEEDS_OWN_CONFIRMATION } = await import('../../../src/main/insights-runner')
const win = () => null
let tmpRoot = ''

function seedClaude(id: string, isPrimary = false, name?: string): void {
  const dir = join(tmpRoot, 'profiles', id)
  mkdirSync(join(dir, '.claude', 'usage-data'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'usage-data', 'report.html'), '<html>report</html>')
  h.profileDir[id] = dir
  h.profiles.push({ id, accountEmail: `${id}@example.com`, isPrimary, name })
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ins-codex-rollup-'))
  h.resourcesDir = join(tmpRoot, 'resources')
  h.sessionsDir = join(tmpRoot, 'realm', 'sessions')
  mkdirSync(h.resourcesDir, { recursive: true })
  const day = join(h.sessionsDir, '2026', '10', '01')
  mkdirSync(day, { recursive: true })
  const at = new Date().toISOString()
  writeFileSync(join(day, 'rollout-x.jsonl'), [
    { timestamp: at, type: 'session_meta', payload: { cwd: join(tmpRoot, 'proj') } },
    { timestamp: at, type: 'event_msg', payload: { type: 'task_started' } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n')
  h.claude = 'on'
  h.codex = 'on'
  h.claudeKpiFails = false
  h.profileDir = {}
  h.profiles = []
  h.prepareCalls = []
  h.execPrompts = []
  h.claudePrompts = []
  h.codexInUseDuringExec = []
  h.claudeInUseDuringExec = []
})
afterEach(() => { try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ } })

describe('Run all over both assistants (C1 A)', () => {
  it("one roll-up: every Claude Code profile and every Codex account that needs no confirmation; the others named, never run [host]", async () => {
    seedClaude('work', true, 'Work')
    seedClaude('personal', false, 'Personal')
    const id = await runCrossAccountInsights(win) as string
    const agg = getCatalogue().runs.find((r) => r.id === id)!
    expect(agg).toMatchObject({ status: 'complete', kind: 'aggregate' })
    expect(agg.members!.map((m) => [m.label, m.status])).toEqual([
      ['Work', 'complete'],
      ['Personal', 'complete'],
      ['Work (Codex)', 'complete'],
      ['Reviewer (Codex)', 'complete'],
      ["This computer's Codex", 'failed'],
    ])
    expect(agg.members!.find((m) => m.profileId === EXT)!.error).toBe(CODEX_NEEDS_OWN_CONFIRMATION)
    // The one needing its own confirmation was never launched; blocked and archived ones are not named.
    expect(h.prepareCalls.map((c) => c.providerAccountId)).toEqual([ACCT, ACCT2])
    expect(agg.memberRunIds).toHaveLength(4)
    const data = getInsightsKpis(id) as any
    expect(data.accounts.map((a: { label: string }) => a.label)).toEqual(['Work', 'Personal', 'Work (Codex)', 'Reviewer (Codex)'])
    // Each member's own run carries its assistant.
    const providers = agg.memberRunIds!.map((rid) => getCatalogue().runs.find((r) => r.id === rid)!.provider ?? 'claude')
    expect(providers).toEqual(['claude', 'claude', 'codex', 'codex'])
  })

  it("the written analysis runs on the primary (Claude Code) and is told the roll-up holds both assistants [host]", async () => {
    seedClaude('work', true)
    seedClaude('personal')
    const id = await runCrossAccountInsights(win) as string
    expect(h.claudePrompts).toHaveLength(1)
    expect(h.claudePrompts[0].startsWith('You are comparing Claude Code and Codex usage across several accounts belonging to ONE person')).toBe(true)
    expect(h.execPrompts.filter((p) => p.startsWith('You are comparing'))).toEqual([])
    expect((getInsightsKpis(id) as any).crossAccount.observations).toEqual(['Claude wrote this'])
    // A roll-up that runs Claude Code is Claude Code in use while its Codex members run too (review F6b).
    expect(h.claudeInUseDuringExec.length).toBeGreaterThan(0)
    expect(h.claudeInUseDuringExec.every((n) => n >= 1)).toBe(true)
  })

  it("the prompt names the assistants of the members that produced figures: Claude Code's all failed, so Codex alone (review F8) [host]", async () => {
    seedClaude('work', true)
    seedClaude('personal')
    h.claudeKpiFails = true
    const id = await runCrossAccountInsights(win) as string
    expect(getCatalogue().runs.find((r) => r.id === id)!.status).toBe('complete')
    const synth = h.execPrompts.filter((p) => p.startsWith('You are comparing'))
    expect(synth).toHaveLength(1)
    expect(synth[0].startsWith('You are comparing Codex usage across several accounts')).toBe(true)
  })

  it('a Claude Code roll-up alone keeps its prompt word for word [host]', async () => {
    seedClaude('work', true)
    seedClaude('personal')
    h.codex = 'off'
    await runCrossAccountInsights(win)
    expect(h.claudePrompts[0].startsWith('You are comparing Claude Code usage across several accounts belonging to ONE person.\n')).toBe(true)
    expect(h.prepareCalls).toEqual([])
  })

  it('with Claude Code off, the Codex accounts still make a roll-up, and Codex writes its analysis (D8) [host]', async () => {
    seedClaude('work', true)
    h.claude = 'off'
    const id = await runCrossAccountInsights(win) as string
    const agg = getCatalogue().runs.find((r) => r.id === id)!
    expect(agg.status).toBe('complete')
    expect(agg.members!.map((m) => m.label)).toEqual(['Work (Codex)', 'Reviewer (Codex)', "This computer's Codex"])
    const synth = h.execPrompts.filter((p) => p.startsWith('You are comparing'))
    expect(synth).toHaveLength(1)
    expect(synth[0].startsWith('You are comparing Codex usage across several accounts')).toBe(true)
    expect(h.claudePrompts).toEqual([])
    expect((getInsightsKpis(id) as any).crossAccount.observations).toEqual(['Codex wrote this'])
    // The analysis ran on a Codex account's own launch.
    expect(h.prepareCalls.filter((c) => String(c.ownerId).endsWith(':synthesis'))).toHaveLength(1)
  })

  it('a roll-up that runs Codex is Codex in use for its length; one without Claude Code is never Claude Code in use [host]', async () => {
    h.claude = 'off'
    await runCrossAccountInsights(win)
    expect(h.codexInUseDuringExec.every((n) => n >= 1)).toBe(true)
    expect(h.claudeInUseDuringExec.every((n) => n === 0)).toBe(true)
    expect(countCodexInsightsRunsUnleased()).toBe(0)
    expect(countInsightsRunsInFlight()).toBe(0)
  })

  it('an explicit list naming only Codex accounts names no Claude Code account [host]', async () => {
    seedClaude('work', true)
    seedClaude('personal')
    const id = await runCrossAccountInsights(win, { profileIds: [ACCT, ACCT2] }) as string
    const agg = getCatalogue().runs.find((r) => r.id === id)!
    expect(agg.members!.map((m) => m.profileId)).toEqual([ACCT, ACCT2])
  })

  it('both assistants refusing: the answer is Claude Code\'s refusal, as it always was [host]', async () => {
    h.claude = 'off'
    h.codex = 'off'
    seedClaude('work', true)
    seedClaude('personal')
    await expect(runCrossAccountInsights(win)).resolves.toEqual({ refused: { code: 'provider-off', providerId: 'claude', message: 'Claude Code is off. Turn it on in Settings, Accounts.' } })
    expect(getCatalogue().runs).toEqual([])
  })

  it("Claude Code off and no Codex account that can run without its own confirmation: Claude Code's refusal (review F11) [host]", async () => {
    h.claude = 'off'
    await expect(runCrossAccountInsights(win, { profileIds: [EXT] })).resolves.toEqual({ refused: { code: 'provider-off', providerId: 'claude', message: 'Claude Code is off. Turn it on in Settings, Accounts.' } })
  })

  it('fewer than two accounts that can run: refused as before, the count says how many [host]', async () => {
    h.claude = 'off'
    await expect(runCrossAccountInsights(win, { profileIds: [ACCT, EXT] })).rejects.toThrow('A cross-account report needs at least 2 signed-in accounts (found 1)')
  })
})
