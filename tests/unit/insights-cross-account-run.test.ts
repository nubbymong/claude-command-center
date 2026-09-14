import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { CrossAccountInsights } from '../../src/shared/types'

// #191: the impure half of a cross-account roll-up — fan-out, the aggregate lock,
// per-member failure isolation, and the degrade-to-numbers path.

const h = vi.hoisted(() => ({
  resourcesDir: '',
  profileDir: {} as Record<string, string>,
  profiles: [] as Array<{ id: string; name?: string; accountEmail: string; isPrimary?: boolean }>,
  /** Raw stdout the per-run KPI extraction returns (a string, so junk is testable). */
  memberKpiStdout: '',
  synthesisStdout: '',
  synthesisCode: 0,
  synthesisPrompts: [] as string[],
  /** Which HOME each synthesis call ran under — proves it avoids a dead account. */
  synthesisHomes: [] as Array<string | null>,
  /** profileId -> raw stdout to fail that account's KPI extraction with. */
  kpiFailFor: {} as Record<string, string>,
  /** When set, the synthesis pass hangs until this is called (in-flight lock tests). */
  holdSynthesis: null as null | (() => void)
}))

vi.mock('../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => h.resourcesDir,
  registerSetupHandlers: () => {}
}))
// isValidProfileId comes from the REAL module via importOriginal — the insights
// runner now guards on it (renderer-supplied ids), so the mock must provide the
// genuine one (which requires the seeded ids be valid, hence lowercase 'a'/'b').
vi.mock('../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/account-profiles')>()),
  getProfileConfigDir: (id: string) => h.profileDir[id] ?? '',
  getPrimaryProfileId: () => h.profiles.find((p) => p.isPrimary)?.id ?? h.profiles[0]?.id ?? null,
  setupProfileLinks: () => {},
  listProfiles: () => h.profiles
}))
vi.mock('../../src/main/update-watcher', () => ({
  getInstallPath: () => '',
  getProjectRootPath: () => ''
}))
vi.mock('../../src/main/pty-manager', () => ({
  resolveClaudeForPty: () => ({ cmd: 'claude' }),
  withProfileHome: (env: unknown) => env
}))
// A PTY that "runs /insights" and exits cleanly straight away. The report.html
// each run then archives is seeded per-profile in the test setup.
vi.mock('node-pty', () => ({
  spawn: () => ({
    onData: () => {},
    onExit: (cb: (e: { exitCode: number }) => void) => cb({ exitCode: 0 }),
    write: () => {},
    kill: () => {}
  })
}))
// Two different headless calls share this spawner: the per-run KPI extraction
// (which passes --allowedTools Read) and the cross-account synthesis (no tools).
vi.mock('../../src/main/claude-headless', () => ({
  spawnClaudeHeadless: async (args: string[], _timeout?: number, prompt?: string, home?: string | null) => {
    if (args.includes('--allowedTools')) {
      // Reverse-map the spawn HOME back to a profile so a single account's
      // extraction can be failed independently (the expired-OAuth case).
      const id = Object.keys(h.profileDir).find((k) => h.profileDir[k] === home)
      if (id && h.kpiFailFor[id]) return { code: 1, stdout: h.kpiFailFor[id], stderr: '' }
      return { code: 0, stdout: h.memberKpiStdout, stderr: '' }
    }
    h.synthesisPrompts.push(prompt ?? '')
    h.synthesisHomes.push(home ?? null)
    if (h.holdSynthesis) {
      await new Promise<void>((resolve) => {
        h.holdSynthesis = resolve
      })
    }
    return { code: h.synthesisCode, stdout: h.synthesisStdout, stderr: '' }
  }
}))

import {
  runCrossAccountInsights,
  isCrossAccountRunning,
  resolveCrossAccountTargets,
  getCatalogue
} from '../../src/main/insights-runner'

const getWin = () => null
let tmpRoot = ''

const KPIS = {
  period: { start: '2026-07-01', end: '2026-07-31', days: 31 },
  kpis: {
    Volume: { sessions: { value: 10, label: 'Sessions', format: 'number', goodDirection: 'up' } },
    Outcomes: { successRate: { value: 0.9, label: 'Success Rate', format: 'percent', goodDirection: 'up' } }
  }
}

const NARRATIVE = JSON.stringify({
  summary: { improvements: ['both accounts steady'] },
  accounts: [{ key: 'A1', highlights: ['carries the volume'] }, { key: 'A2', highlights: ['quieter'] }],
  crossAccount: { observations: ['A1 and A2 are level'] }
})

function seedProfile(id: string, email: string, opts: { withReport?: boolean; isPrimary?: boolean } = {}): void {
  const dir = join(tmpRoot, 'profiles', id)
  mkdirSync(dir, { recursive: true })
  h.profileDir[id] = dir
  h.profiles.push({ id, name: `Acct ${id.toUpperCase()}`, accountEmail: email, isPrimary: opts.isPrimary })
  if (opts.withReport !== false) {
    const usage = join(dir, '.claude', 'usage-data')
    mkdirSync(usage, { recursive: true })
    writeFileSync(join(usage, 'report.html'), '<html><body>report</body></html>')
  }
}

function aggregate() {
  return getCatalogue().runs.filter((r) => r.kind === 'aggregate')
}
function readAggregateData(id: string): CrossAccountInsights {
  return JSON.parse(readFileSync(join(h.resourcesDir, 'insights', id, 'kpis.json'), 'utf-8'))
}

describe('runCrossAccountInsights', () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'insights-xacct-'))
    h.resourcesDir = join(tmpRoot, 'resources')
    mkdirSync(h.resourcesDir, { recursive: true })
    h.profileDir = {}
    h.profiles = []
    h.memberKpiStdout = JSON.stringify(KPIS)
    h.synthesisStdout = NARRATIVE
    h.synthesisCode = 0
    h.synthesisPrompts = []
    h.synthesisHomes = []
    h.kpiFailFor = {}
    h.holdSynthesis = null
  })
  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('refuses to run with fewer than two signed-in accounts', async () => {
    seedProfile('a', 'a@example.com', { isPrimary: true })
    await expect(runCrossAccountInsights(getWin)).rejects.toThrow(/at least 2 signed-in accounts/i)
    expect(aggregate()).toHaveLength(0)
    expect(isCrossAccountRunning()).toBe(false)
  })

  it('narrows an explicit id list to real profiles and never widens it', () => {
    seedProfile('a', 'a@example.com', { isPrimary: true })
    seedProfile('b', 'b@example.com')
    expect(resolveCrossAccountTargets().map((p) => p.id)).toEqual(['a', 'b'])
    expect(resolveCrossAccountTargets(['b']).map((p) => p.id)).toEqual(['b'])
    expect(resolveCrossAccountTargets(['b', 'does-not-exist', '../escape']).map((p) => p.id)).toEqual(['b'])
  })

  it('refuses when an explicit id list narrows below two accounts', async () => {
    seedProfile('a', 'a@example.com', { isPrimary: true })
    seedProfile('b', 'b@example.com')
    await expect(runCrossAccountInsights(getWin, { profileIds: ['a', 'ghost'] })).rejects.toThrow(
      /at least 2 signed-in accounts/i
    )
  })

  it('runs every account, then writes one synthesized roll-up', async () => {
    seedProfile('a', 'a@example.com', { isPrimary: true })
    seedProfile('b', 'b@example.com')

    const id = await runCrossAccountInsights(getWin)
    const runs = getCatalogue().runs
    const agg = runs.find((r) => r.id === id)!

    expect(agg.kind).toBe('aggregate')
    expect(agg.status).toBe('complete')
    expect(agg.statusMessage).toBeUndefined()
    expect(agg.profileId).toBeUndefined()
    expect(agg.memberRunIds).toHaveLength(2)
    expect(agg.members?.map((m) => m.status)).toEqual(['complete', 'complete'])
    expect(agg.members?.map((m) => m.label)).toEqual(['Acct A', 'Acct B'])

    // The member runs are ordinary per-account entries alongside the aggregate.
    const memberRuns = runs.filter((r) => r.kind !== 'aggregate')
    expect(memberRuns.map((r) => r.profileId).sort()).toEqual(['a', 'b'])
    expect(memberRuns.every((r) => r.status === 'complete')).toBe(true)

    // An aggregate has no report.html — only its JSON.
    expect(existsSync(join(h.resourcesDir, 'insights', id, 'report.html'))).toBe(false)
    const data = readAggregateData(id)
    expect(data.synthesis).toBe('ai')
    expect(data.accounts.map((a) => a.key)).toEqual(['A1', 'A2'])
    expect(data.accounts.map((a) => a.accountEmail)).toEqual(['a@example.com', 'b@example.com'])
    expect(data.comparison.map((r) => r.metricKey).sort()).toEqual(['sessions', 'successRate'])
    expect(data.crossAccount?.observations).toEqual(['A1 and A2 are level'])

    // Both accounts reached the synthesis prompt, under their opaque keys, as an
    // aligned table rather than raw per-account JSON blobs.
    expect(h.synthesisPrompts).toHaveLength(1)
    expect(h.synthesisPrompts[0]).toContain('A1 = Acct A')
    expect(h.synthesisPrompts[0]).toContain('A2 = Acct B')
    expect(h.synthesisPrompts[0]).toContain('SHARED METRICS')
    expect(h.synthesisPrompts[0]).not.toContain('"goodDirection"')
    // The prompt is built from the SAME assembled roll-up that gets persisted, so
    // the model cannot have reasoned over a different table than the user sees.
    expect(h.synthesisPrompts[0]).toContain('Volume | Sessions (up) | 10 | 10 | 20')

    expect(isCrossAccountRunning()).toBe(false)
  })

  it('still completes with a numbers-only roll-up when the synthesis pass fails', async () => {
    seedProfile('a', 'a@example.com', { isPrimary: true })
    seedProfile('b', 'b@example.com')
    h.synthesisCode = 1
    h.synthesisStdout = 'the model fell over'

    const id = await runCrossAccountInsights(getWin)
    const agg = getCatalogue().runs.find((r) => r.id === id)!
    expect(agg.status).toBe('complete')

    const data = readAggregateData(id)
    expect(data.synthesis).toBe('deterministic')
    expect(data.summary).toBeUndefined()
    expect(data.comparison.length).toBeGreaterThan(0)
  })

  it('degrades to numbers-only when the synthesis reply is unusable JSON', async () => {
    seedProfile('a', 'a@example.com', { isPrimary: true })
    seedProfile('b', 'b@example.com')
    h.synthesisStdout = 'here is your report, in prose, with no JSON'

    const id = await runCrossAccountInsights(getWin)
    expect(readAggregateData(id).synthesis).toBe('deterministic')
  })

  it('isolates a failed member and fails the roll-up when too few accounts survive', async () => {
    seedProfile('a', 'a@example.com', { isPrimary: true })
    seedProfile('b', 'b@example.com', { withReport: false }) // /insights produced nothing to archive

    const id = await runCrossAccountInsights(getWin)
    const agg = getCatalogue().runs.find((r) => r.id === id)!

    expect(agg.status).toBe('failed')
    expect(agg.error).toMatch(/Only 1 of 2 accounts produced KPIs/)
    const byProfile = new Map(agg.members!.map((m) => [m.profileId, m]))
    expect(byProfile.get('a')!.status).toBe('complete')
    expect(byProfile.get('b')!.status).toBe('failed')
    expect(byProfile.get('b')!.error).toMatch(/copy report/i)
    // No roll-up artifact for a refused roll-up.
    expect(existsSync(join(h.resourcesDir, 'insights', id, 'kpis.json'))).toBe(false)
    expect(h.synthesisPrompts).toHaveLength(0)
    expect(isCrossAccountRunning()).toBe(false)
  })

  it('records a member whose report completed without KPIs and leaves it out', async () => {
    seedProfile('a', 'a@example.com', { isPrimary: true })
    seedProfile('b', 'b@example.com')
    // Extraction succeeds but returns unparseable output, which is the real
    // "report is viewable, KPIs unavailable" case — the member run completes.
    h.memberKpiStdout = 'sorry, no JSON for you'

    const id = await runCrossAccountInsights(getWin)
    const agg = getCatalogue().runs.find((r) => r.id === id)!
    expect(agg.status).toBe('failed')
    expect(agg.error).toMatch(/Only 0 of 2 accounts produced KPIs/)
    expect(agg.members?.map((m) => m.status)).toEqual(['complete', 'complete'])
    expect(agg.members?.every((m) => m.kpisUnavailable)).toBe(true)
    expect(h.synthesisPrompts).toHaveLength(0)
  })

  it('runs the synthesis under a member that just authenticated, not a dead primary', async () => {
    // The real failure: the PRIMARY account's OAuth session had expired, so the
    // synthesis pass failed with 0 tokens and the roll-up degraded to numbers-only
    // even though two other accounts had authenticated seconds earlier.
    seedProfile('a', 'a@example.com', { withReport: false, isPrimary: true }) // primary produces no KPIs
    seedProfile('b', 'b@example.com')
    seedProfile('c', 'c@example.com')

    const id = await runCrossAccountInsights(getWin)
    const agg = getCatalogue().runs.find((r) => r.id === id)!
    expect(agg.status).toBe('complete')
    expect(h.synthesisHomes).toHaveLength(1)
    // Not the primary's home: the primary contributed nothing to this roll-up.
    expect(h.synthesisHomes[0]).not.toBe(h.profileDir['a'])
    expect([h.profileDir['b'], h.profileDir['c']]).toContain(h.synthesisHomes[0])
  })

  it('prefers the primary when the primary DID produce KPIs', async () => {
    seedProfile('a', 'a@example.com', { isPrimary: true })
    seedProfile('b', 'b@example.com')

    await runCrossAccountInsights(getWin)
    expect(h.synthesisHomes[0]).toBe(h.profileDir['a'])
  })

  it('carries a completed-but-no-KPIs member reason so the UI can name it', async () => {
    seedProfile('a', 'a@example.com', { isPrimary: true })
    seedProfile('b', 'b@example.com')
    seedProfile('c', 'c@example.com')
    // C's extraction hard-fails with an authentication error, like the real run.
    h.kpiFailFor = { c: '{"is_error":true,"result":"Failed to authenticate: OAuth session expired and could not be refreshed","duration_api_ms":0}' }

    const id = await runCrossAccountInsights(getWin)
    const agg = getCatalogue().runs.find((r) => r.id === id)!
    const c = agg.members!.find((m) => m.profileId === 'c')!
    expect(c.status).toBe('complete')
    expect(c.kpisUnavailable).toBe(true)
    expect(c.error).toMatch(/OAuth session expired/)
    // Classified, so the Insights page can offer the re-auth action rather than
    // just reporting that something went wrong.
    expect(c.authFailed).toBe(true)
    // The member's own run carries the same flags, which is what the page-level
    // banner reads (latest run per profile).
    const memberRun = getCatalogue().runs.find((r) => r.id === c.runId)!
    expect(memberRun.authFailed).toBe(true)
    expect(memberRun.error).toMatch(/OAuth session expired/)
  })

  it('explains a missing written analysis instead of degrading silently', async () => {
    seedProfile('a', 'a@example.com', { isPrimary: true })
    seedProfile('b', 'b@example.com')
    h.synthesisCode = 1
    h.synthesisStdout = JSON.stringify({
      is_error: true,
      result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
      duration_api_ms: 0
    })

    const id = await runCrossAccountInsights(getWin)
    const agg = getCatalogue().runs.find((r) => r.id === id)!
    // Still completes as a numbers-only roll-up...
    expect(agg.status).toBe('complete')
    expect(readAggregateData(id).synthesis).toBe('deterministic')
    // ...but says why, and names the account to fix.
    expect(agg.error).toMatch(/No written analysis/)
    expect(agg.error).toMatch(/needs to sign in again/)
    expect(agg.error).toMatch(/Acct A/)
    expect(agg.authFailed).toBe(true)
  })

  it('does not claim an auth problem when the synthesis failed for another reason', async () => {
    seedProfile('a', 'a@example.com', { isPrimary: true })
    seedProfile('b', 'b@example.com')
    h.synthesisStdout = 'prose with no JSON at all'

    const id = await runCrossAccountInsights(getWin)
    const agg = getCatalogue().runs.find((r) => r.id === id)!
    expect(agg.error).toMatch(/No written analysis/)
    expect(agg.error).not.toMatch(/sign in again/)
    expect(agg.authFailed).toBeUndefined()
  })

  it('holds an aggregate-level lock so two roll-ups cannot overlap', async () => {
    seedProfile('a', 'a@example.com', { isPrimary: true })
    seedProfile('b', 'b@example.com')
    h.holdSynthesis = () => {} // replaced with the resolver once the pass is reached

    const first = runCrossAccountInsights(getWin)
    // Let the fan-out finish and the synthesis pass park.
    await vi.waitFor(() => expect(h.synthesisPrompts).toHaveLength(1))
    expect(isCrossAccountRunning()).toBe(true)

    await expect(runCrossAccountInsights(getWin)).rejects.toThrow(/already being generated/i)
    expect(aggregate()).toHaveLength(1)

    h.holdSynthesis!()
    await first
    expect(isCrossAccountRunning()).toBe(false)
  })
})
