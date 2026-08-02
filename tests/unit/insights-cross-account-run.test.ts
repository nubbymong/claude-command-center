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
  /** When set, the synthesis pass hangs until this is called (in-flight lock tests). */
  holdSynthesis: null as null | (() => void)
}))

vi.mock('../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => h.resourcesDir,
  registerSetupHandlers: () => {}
}))
vi.mock('../../src/main/account-profiles', () => ({
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
  spawnClaudeHeadless: async (args: string[], _timeout?: number, prompt?: string) => {
    if (args.includes('--allowedTools')) {
      return { code: 0, stdout: h.memberKpiStdout, stderr: '' }
    }
    h.synthesisPrompts.push(prompt ?? '')
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
  h.profiles.push({ id, name: `Acct ${id}`, accountEmail: email, isPrimary: opts.isPrimary })
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
    h.holdSynthesis = null
  })
  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('refuses to run with fewer than two signed-in accounts', async () => {
    seedProfile('A', 'a@example.com', { isPrimary: true })
    await expect(runCrossAccountInsights(getWin)).rejects.toThrow(/at least 2 signed-in accounts/i)
    expect(aggregate()).toHaveLength(0)
    expect(isCrossAccountRunning()).toBe(false)
  })

  it('narrows an explicit id list to real profiles and never widens it', () => {
    seedProfile('A', 'a@example.com', { isPrimary: true })
    seedProfile('B', 'b@example.com')
    expect(resolveCrossAccountTargets().map((p) => p.id)).toEqual(['A', 'B'])
    expect(resolveCrossAccountTargets(['B']).map((p) => p.id)).toEqual(['B'])
    expect(resolveCrossAccountTargets(['B', 'does-not-exist', '../escape']).map((p) => p.id)).toEqual(['B'])
  })

  it('refuses when an explicit id list narrows below two accounts', async () => {
    seedProfile('A', 'a@example.com', { isPrimary: true })
    seedProfile('B', 'b@example.com')
    await expect(runCrossAccountInsights(getWin, { profileIds: ['A', 'ghost'] })).rejects.toThrow(
      /at least 2 signed-in accounts/i
    )
  })

  it('runs every account, then writes one synthesized roll-up', async () => {
    seedProfile('A', 'a@example.com', { isPrimary: true })
    seedProfile('B', 'b@example.com')

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
    expect(memberRuns.map((r) => r.profileId).sort()).toEqual(['A', 'B'])
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
    seedProfile('A', 'a@example.com', { isPrimary: true })
    seedProfile('B', 'b@example.com')
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
    seedProfile('A', 'a@example.com', { isPrimary: true })
    seedProfile('B', 'b@example.com')
    h.synthesisStdout = 'here is your report, in prose, with no JSON'

    const id = await runCrossAccountInsights(getWin)
    expect(readAggregateData(id).synthesis).toBe('deterministic')
  })

  it('isolates a failed member and fails the roll-up when too few accounts survive', async () => {
    seedProfile('A', 'a@example.com', { isPrimary: true })
    seedProfile('B', 'b@example.com', { withReport: false }) // /insights produced nothing to archive

    const id = await runCrossAccountInsights(getWin)
    const agg = getCatalogue().runs.find((r) => r.id === id)!

    expect(agg.status).toBe('failed')
    expect(agg.error).toMatch(/Only 1 of 2 accounts produced KPIs/)
    const byProfile = new Map(agg.members!.map((m) => [m.profileId, m]))
    expect(byProfile.get('A')!.status).toBe('complete')
    expect(byProfile.get('B')!.status).toBe('failed')
    expect(byProfile.get('B')!.error).toMatch(/copy report/i)
    // No roll-up artifact for a refused roll-up.
    expect(existsSync(join(h.resourcesDir, 'insights', id, 'kpis.json'))).toBe(false)
    expect(h.synthesisPrompts).toHaveLength(0)
    expect(isCrossAccountRunning()).toBe(false)
  })

  it('records a member whose report completed without KPIs and leaves it out', async () => {
    seedProfile('A', 'a@example.com', { isPrimary: true })
    seedProfile('B', 'b@example.com')
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

  it('holds an aggregate-level lock so two roll-ups cannot overlap', async () => {
    seedProfile('A', 'a@example.com', { isPrimary: true })
    seedProfile('B', 'b@example.com')
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
