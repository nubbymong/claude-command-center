import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// release-gate.mjs is plain ESM and guards main() behind an argv[1] check, so
// importing it here pulls in the pure verdict logic without touching GitHub.
// Everything external (the REST list calls) is injected through `listAll`.
import {
  evaluateMilestone,
  evaluateModels,
  evaluateCodexModels,
  formatReport,
  registryIdCovers,
  repoFromUrl,
  repoFromPackageJson,
  runGate,
  githubListAll,
  resolveToken,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_CANNOT_EVALUATE,
  EXCLUDED_LABEL,
  DEFAULT_REGISTRY_PATH,
  DEFAULT_EXPECTED_PATH,
  DEFAULT_CODEX_EXPECTED_PATH,
  DEFAULT_MACOS_FLOORS_PATH,
  evaluateMacosFloor,
  electronVersionOf,
} from '../../../scripts/release-gate.mjs'

type Issue = { number: number; title: string; labels?: Array<{ name: string } | string>; pull_request?: object; state?: string }
type Milestone = { number: number; title: string; state?: string }

const EXPECTED = {
  source: 'https://example.test/article',
  fetchedAt: '2026-08-22',
  models: [
    { label: 'Opus 4.8', id: 'claude-opus-4-8' },
    { label: 'Sonnet 4.6', id: 'claude-sonnet-4-6' },
    { label: 'Haiku 4.5', id: 'claude-haiku-4-5-20251001' },
  ],
}

const REGISTRY_OK = {
  models: [
    { id: 'claude-opus-4-8', family: 'opus', label: 'Opus 4.8' },
    { id: 'claude-sonnet-4-6', family: 'sonnet', label: 'Sonnet 4.6' },
    { id: 'claude-haiku-4-5', family: 'haiku', label: 'Haiku 4.5' },
    { id: 'codex-family', family: 'codex', label: 'Codex', pickable: false },
    { id: 'gpt-5.5', family: 'codex', label: 'GPT-5.5' },
  ],
}

// The Codex half's list (P3.8 round 1, G1): resources/codex-model-catalogue.json's shape.
const CODEX_EXPECTED = {
  source: 'the model catalogue bundled with the Codex CLI',
  cliVersions: ['0.155.1'],
  fetchedAt: '2026-09-29',
  models: [{ label: 'GPT-5.5', id: 'gpt-5.5' }],
}

/** A fake GitHub: one milestone list, issues keyed by milestone number. */
function fakeGitHub(milestones: Milestone[], issuesByMilestone: Record<number, Issue[]>) {
  const calls: string[] = []
  const listAll = async (p: string): Promise<unknown[]> => {
    calls.push(p)
    if (p.startsWith('/repos/o/r/milestones')) return milestones
    const m = /\/repos\/o\/r\/issues\?milestone=(\d+)&state=open/.exec(p)
    if (m) return issuesByMilestone[Number(m[1])] ?? []
    throw new Error(`unexpected path ${p}`)
  }
  return { listAll, calls }
}

const silent = () => {}

// The macOS floor half (check 4): resources/macos-release-floors.json's shape.
const FLOORS = { floors: [{ fromTag: 'v2.1.1-beta.2', electronMajor: 44, macosMajor: 13 }] }
/** An Electron that needs no macOS floor, so the other checks decide (their cases' versions predate any floor). */
const MAC_OK = { electronVersion: '43.7.1', macosFloors: FLOORS }

// ── evaluateMilestone ──────────────────────────────────────────────
describe('release-gate evaluateMilestone', () => {
  const milestones: Milestone[] = [{ number: 7, title: '2.1.0-beta.17' }, { number: 8, title: '2.2' }]

  it('passes a milestone with no open issues', () => {
    const r = evaluateMilestone({ version: '2.1.0-beta.17', milestones, issues: [] })
    expect(r.ok).toBe(true)
    expect(r.milestone?.number).toBe(7)
    expect(r.blocking).toEqual([])
  })

  it('fails and lists every open issue that is not excluded, ascending', () => {
    const issues: Issue[] = [
      { number: 385, title: 'Model picker', labels: [{ name: 'bug' }] },
      { number: 358, title: 'Command bar', labels: [{ name: 'enhancement' }, { name: 'ux' }] },
    ]
    const r = evaluateMilestone({ version: '2.1.0-beta.17', milestones, issues })
    expect(r.ok).toBe(false)
    expect(r.blocking.map((i) => i.number)).toEqual([358, 385])
    expect(r.blocking[0].labels).toEqual(['enhancement', 'ux'])
    expect(r.reason).toContain('2 open issue(s)')
  })

  it('ignores issues carrying the excluded label (owner-excluded from the gate)', () => {
    const issues: Issue[] = [
      { number: 374, title: 'GPU rendering', labels: [{ name: EXCLUDED_LABEL }, { name: 'enhancement' }] },
    ]
    const r = evaluateMilestone({ version: '2.1.0-beta.17', milestones, issues })
    expect(r.ok).toBe(true)
    expect(r.excluded.map((i) => i.number)).toEqual([374])
  })

  it('accepts labels as plain strings too', () => {
    const r = evaluateMilestone({ version: '2.1.0-beta.17', milestones, issues: [{ number: 1, title: 'x', labels: ['excluded'] }] })
    expect(r.ok).toBe(true)
  })

  it('an open in-beta issue is DONE for this release, not outstanding — the lifecycle keeps it open until promotion', () => {
    const issues: Issue[] = [
      { number: 373, title: 'Canvas: per-note A/B/C approve', labels: [{ name: 'in-beta' }, { name: 'canvas' }] },
      { number: 377, title: 'Tips re-review', labels: [{ name: 'in-beta' }] },
    ]
    const r = evaluateMilestone({ version: '2.1.0-beta.17', milestones, issues })
    expect(r.ok).toBe(true)
    expect(r.shipped.map((i) => i.number)).toEqual([373, 377])
    expect(r.blocking).toEqual([])
  })

  it('an open in-release issue (rolled into an rc) is likewise DONE, not outstanding', () => {
    const issues: Issue[] = [
      { number: 373, title: 'rolled into rc.1', labels: [{ name: 'in-release' }] },
      { number: 377, title: 'merged after the rc cut', labels: [{ name: 'in-beta' }] },
    ]
    const r = evaluateMilestone({ version: '2.1.0-beta.17', milestones, issues })
    expect(r.ok).toBe(true)
    expect(r.shipped.map((i) => i.number)).toEqual([373, 377])
    expect(r.blocking).toEqual([])
  })

  it('the FAIL report lists blockers, the shipped riders, and the in-beta remediation route', () => {
    const issues: Issue[] = [
      { number: 373, title: 'shipped', labels: ['in-beta'] },
      { number: 412, title: 'still outstanding', labels: ['enhancement'] },
    ]
    const mr = evaluateMilestone({ version: '2.1.0-beta.17', milestones, issues })
    const text = formatReport({ version: '2.1.0-beta.17', repo: 'o/r', milestoneResult: mr, modelsResult: null, expectedMeta: null }).join('\n')
    expect(text).toContain('#412  still outstanding')
    expect(text).toContain('(in-beta/in-release, shipping in this release: #373)')
    expect(text).toContain('Merge their fixes (label "in-beta")')
    expect(mr.reason).toContain('"in-release"')
  })

  it('the OK report names what is shipping', () => {
    const mr = evaluateMilestone({ version: '2.1.0-beta.17', milestones, issues: [{ number: 373, title: 's', labels: ['in-beta'] }] })
    const text = formatReport({ version: '2.1.0-beta.17', repo: 'o/r', milestoneResult: mr, modelsResult: null, expectedMeta: null }).join('\n')
    expect(text).toContain('has no outstanding issues')
    expect(text).toContain('(1 shipping in this release: #373)')
  })

  it('an issue carrying BOTH labels lands in excluded — the stronger owner claim wins', () => {
    const issues: Issue[] = [{ number: 1, title: 'x', labels: ['excluded', 'in-beta'] }]
    const r = evaluateMilestone({ version: '2.1.0-beta.17', milestones, issues })
    expect(r.ok).toBe(true)
    expect(r.excluded.map((i) => i.number)).toEqual([1])
    expect(r.shipped).toEqual([])
  })

  it('an in-beta issue does not shield a genuinely open one beside it', () => {
    const issues: Issue[] = [
      { number: 373, title: 'shipped', labels: [{ name: 'in-beta' }] },
      { number: 412, title: 'still outstanding', labels: [{ name: 'enhancement' }] },
    ]
    const r = evaluateMilestone({ version: '2.1.0-beta.17', milestones, issues })
    expect(r.ok).toBe(false)
    expect(r.blocking.map((i) => i.number)).toEqual([412])
    expect(r.shipped.map((i) => i.number)).toEqual([373])
    expect(r.reason).toContain('"in-beta"')
  })

  it('ignores pull requests and non-open items on the milestone', () => {
    const issues: Issue[] = [
      { number: 390, title: 'feat: something', pull_request: { url: 'x' } },
      { number: 391, title: 'closed already', state: 'closed' },
    ]
    const r = evaluateMilestone({ version: '2.1.0-beta.17', milestones, issues })
    expect(r.ok).toBe(true)
  })

  it('fails CLOSED when no milestone carries the version as its title', () => {
    const r = evaluateMilestone({ version: '2.1.0-beta.18', milestones, issues: [] })
    expect(r.ok).toBe(false)
    expect(r.milestone).toBeNull()
    expect(r.reason).toMatch(/no GitHub milestone titled "2.1.0-beta.18"/)
  })

  it('matches the milestone title exactly — "2.2" is not "2.2.0"', () => {
    expect(evaluateMilestone({ version: '2.2.0', milestones, issues: [] }).ok).toBe(false)
    expect(evaluateMilestone({ version: ' 2.2 ', milestones, issues: [] }).ok).toBe(true)
  })
})

// ── evaluateModels ─────────────────────────────────────────────────
describe('release-gate evaluateModels', () => {
  it('passes when every article model is covered (dated article ids resolve to the undated registry entry)', () => {
    const r = evaluateModels({ registry: REGISTRY_OK, expected: EXPECTED })
    expect(r.ok).toBe(true)
    expect(r.missing).toEqual([])
    expect(r.covered).toContainEqual({ id: 'claude-haiku-4-5-20251001', by: 'claude-haiku-4-5' })
    expect(r.extra).toEqual([])   // codex-family is not a Claude model
  })

  it('fails with the missing ids when the article names a model the registry lacks', () => {
    const registry = { models: REGISTRY_OK.models.filter((m) => m.id !== 'claude-sonnet-4-6') }
    const r = evaluateModels({ registry, expected: EXPECTED })
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual([{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }])
  })

  it('flags (but does not fail on) a registry Claude model the article no longer lists', () => {
    const registry = { models: [...REGISTRY_OK.models, { id: 'claude-opus-4-8-fast', family: 'opus', label: 'Opus 4.8 Fast' }] }
    const r = evaluateModels({ registry, expected: EXPECTED })
    expect(r.ok).toBe(true)
    expect(r.extra).toEqual([{ id: 'claude-opus-4-8-fast', label: 'Opus 4.8 Fast' }])
  })

  it('FAILS CLOSED when the expected-models fixture is empty or missing — a truncated fixture must not vacuously pass', () => {
    for (const expected of [{ models: [] }, {}, null, undefined]) {
      const r = evaluateModels({ registry: REGISTRY_OK, expected })
      expect(r.ok, JSON.stringify(expected)).toBe(false)
      expect(r.reason).toMatch(/empty or missing|cannot verify|fail closed/i)
    }
  })

  it('registryIdCovers: equal, or equal minus a -YYYYMMDD suffix — nothing looser', () => {
    expect(registryIdCovers('claude-opus-4-5', 'claude-opus-4-5-20251101')).toBe(true)
    expect(registryIdCovers('claude-opus-4-5', 'claude-opus-4-5')).toBe(true)
    // a bare family id must NOT cover a versioned one — that is the #385 bug shape
    expect(registryIdCovers('claude-opus', 'claude-opus-4-5-20251101')).toBe(false)
    expect(registryIdCovers('claude-opus-4', 'claude-opus-4-5')).toBe(false)
    expect(registryIdCovers('claude-opus-4-5', 'claude-opus-4-5-fast')).toBe(false)
  })
})

// ── runGate (mocked GitHub) ────────────────────────────────────────
describe('release-gate runGate', () => {
  it('clean milestone + covered registry → exit 0 with a PASS line', async () => {
    const gh = fakeGitHub([{ number: 7, title: '2.1.0-beta.17' }], { 7: [] })
    const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: gh.listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected: CODEX_EXPECTED, ...MAC_OK, log: silent })
    expect(r.exitCode).toBe(EXIT_OK)
    expect(r.lines.at(-1)).toMatch(/^PASS/)
    expect(gh.calls).toEqual(['/repos/o/r/milestones?state=all', '/repos/o/r/issues?milestone=7&state=open'])
  })

  it('open issue → exit 1 and the issue is printed by number and title', async () => {
    const gh = fakeGitHub([{ number: 7, title: '2.1.0-beta.17' }], { 7: [{ number: 377, title: 'Tips re-review', labels: [{ name: 'ux' }] }] })
    const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: gh.listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected: CODEX_EXPECTED, ...MAC_OK, log: silent })
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines.join('\n')).toMatch(/#377\s+Tips re-review\s+\[ux\]/)
    expect(r.lines.at(-1)).toMatch(/^REFUSED/)
  })

  it('excluded label ignored → exit 0, and the excluded issue is named in the OK line', async () => {
    const gh = fakeGitHub([{ number: 7, title: '2.1.0-beta.17' }], { 7: [{ number: 374, title: 'GPU', labels: [{ name: 'excluded' }] }] })
    const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: gh.listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected: CODEX_EXPECTED, ...MAC_OK, log: silent })
    expect(r.exitCode).toBe(EXIT_OK)
    expect(r.lines.join('\n')).toMatch(/excluded by the owner: #374/)
  })

  it('missing milestone → exit 1 (fails closed) and never queries issues', async () => {
    const gh = fakeGitHub([{ number: 8, title: '2.2' }], {})
    const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: gh.listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected: CODEX_EXPECTED, ...MAC_OK, log: silent })
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines.join('\n')).toMatch(/no GitHub milestone titled "2.1.0-beta.17"/)
    expect(gh.calls).toEqual(['/repos/o/r/milestones?state=all'])
  })

  it('model check fails → exit 1 even when the milestone is clean, with a diff of the missing ids', async () => {
    const gh = fakeGitHub([{ number: 7, title: '2.1.0-beta.17' }], { 7: [] })
    const registry = { models: REGISTRY_OK.models.filter((m) => m.id !== 'claude-opus-4-8') }
    const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: gh.listAll, registry, expected: EXPECTED, codexExpected: CODEX_EXPECTED, ...MAC_OK, log: silent })
    expect(r.exitCode).toBe(EXIT_REFUSED)
    const text = r.lines.join('\n')
    expect(text).toMatch(/OK\s+milestone/)
    expect(text).toMatch(/FAIL\s+model registry/)
    expect(text).toMatch(/- claude-opus-4-8\s+\(Opus 4.8\)/)
  })

  it('model check passes → the OK line says how many models are covered', async () => {
    const gh = fakeGitHub([{ number: 7, title: '2.1.0-beta.17' }], { 7: [] })
    const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: gh.listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected: CODEX_EXPECTED, ...MAC_OK, log: silent })
    expect(r.lines.join('\n')).toMatch(/OK\s+model registry covers all 3 supported Claude Code models/)
  })

  it('GitHub unreachable → exit 2 (cannot evaluate), not a pass', async () => {
    const listAll = async () => { throw new Error('GitHub API 503 for /repos/o/r/milestones?state=all') }
    const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected: CODEX_EXPECTED, ...MAC_OK, log: silent })
    expect(r.exitCode).toBe(EXIT_CANNOT_EVALUATE)
    expect(r.lines[0]).toMatch(/CANNOT EVALUATE/)
  })

  it('no version / no repo → exit 2', async () => {
    const gh = fakeGitHub([], {})
    expect((await runGate({ version: '', repo: 'o/r', listAll: gh.listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected: CODEX_EXPECTED, ...MAC_OK, log: silent })).exitCode).toBe(EXIT_CANNOT_EVALUATE)
    expect((await runGate({ version: '1.0.0', repo: null, listAll: gh.listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected: CODEX_EXPECTED, ...MAC_OK, log: silent })).exitCode).toBe(EXIT_CANNOT_EVALUATE)
  })
})

// -- the Codex half (P3.8 round 1, G1) --
describe('release-gate Codex models', () => {
  const clean = () => fakeGitHub([{ number: 7, title: '2.1.0-beta.17' }], { 7: [] })

  it('a Codex model the list names but the registry lacks -> exit 1, with a diff, even when everything else is clean', async () => {
    const codexExpected = { ...CODEX_EXPECTED, models: [...CODEX_EXPECTED.models, { label: 'GPT-6-Astra', id: 'gpt-6-astra' }] }
    const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: clean().listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected, ...MAC_OK, log: silent })
    expect(r.exitCode).toBe(EXIT_REFUSED)
    const text = r.lines.join('\n')
    expect(text).toMatch(/OK\s+milestone/)
    expect(text).toMatch(/OK\s+model registry covers all 3/)
    expect(text).toMatch(/FAIL\s+Codex models: 1 model\(s\) the Codex CLI lists are not in the registry/)
    expect(text).toMatch(/- gpt-6-astra\s+\(GPT-6-Astra\)/)
    expect(r.codexResult.missing.map((m: { id: string }) => m.id)).toEqual(['gpt-6-astra'])
  })

  it('a Codex model the list no longer names is a WARNING, not a refusal', async () => {
    const registry = { models: [...REGISTRY_OK.models, { id: 'gpt-5.2', family: 'codex', label: 'GPT-5.2' }] }
    const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: clean().listAll, registry, expected: EXPECTED, codexExpected: CODEX_EXPECTED, ...MAC_OK, log: silent })
    expect(r.exitCode).toBe(EXIT_OK)
    expect(r.lines.join('\n')).toMatch(/WARN\s+gpt-5\.2 \(GPT-5\.2\) is a Codex model in the registry but the Codex list no longer names it/)
  })

  it('the OK line says how many Codex models are covered and from which CLI versions', async () => {
    const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: clean().listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected: CODEX_EXPECTED, ...MAC_OK, log: silent })
    expect(r.exitCode).toBe(EXIT_OK)
    expect(r.lines.join('\n')).toMatch(/OK\s+Codex models: the registry covers all 1 models Codex 0\.155\.1 lists \(list read 2026-09-29\)/)
  })

  it('FAILS CLOSED when the Codex list is missing or empty: a caller that forgets it cannot pass', async () => {
    for (const codexExpected of [undefined, null, { models: [] }, { models: [{ id: '' }] }]) {
      const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: clean().listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected, ...MAC_OK, log: silent })
      expect(r.exitCode).toBe(EXIT_REFUSED)
      expect(r.lines.join('\n')).toMatch(/FAIL\s+Codex models: the expected Codex models list is empty or missing/)
    }
  })

  it('a Codex id the registry lists twice refuses, and the report names it (round 2, GS)', async () => {
    const registry = { models: [{ id: 'gpt-5.5', family: 'opus', label: 'x' }, ...REGISTRY_OK.models] }
    const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: fakeGitHub([{ number: 7, title: '2.1.0-beta.17' }], { 7: [] }).listAll, registry, expected: EXPECTED, codexExpected: CODEX_EXPECTED, ...MAC_OK, log: silent })
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines.join('\n')).toMatch(/gpt-5\.5 is listed more than once in resources\/model-registry\.json/)
  })

  it('a malformed Codex list refuses rather than throwing (round 2, GS)', async () => {
    for (const codexExpected of [{ models: {} }, { models: 'gpt-5.5' }, { models: [{ id: 42 }] }]) {
      const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: fakeGitHub([{ number: 7, title: '2.1.0-beta.17' }], { 7: [] }).listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected, ...MAC_OK, log: silent })
      expect(r.exitCode, JSON.stringify(codexExpected)).toBe(EXIT_REFUSED)
    }
  })

  it('only the codex family counts: a Claude-family entry with a Codex id does not cover it', () => {
    const registry = { models: [{ id: 'gpt-5.5', family: 'opus', label: 'x' }] }
    const r = evaluateCodexModels({ registry, expected: CODEX_EXPECTED })
    expect(r.ok).toBe(false)
    expect(r.missing.map((m: { id: string }) => m.id)).toEqual(['gpt-5.5'])
  })

  it('main reads the Codex list from the shipped catalogue by default', () => {
    expect(resolve(DEFAULT_CODEX_EXPECTED_PATH)).toMatch(/resources[\\/]codex-model-catalogue\.json$/)
    const list = JSON.parse(readFileSync(DEFAULT_CODEX_EXPECTED_PATH, 'utf-8'))
    const registry = JSON.parse(readFileSync(DEFAULT_REGISTRY_PATH, 'utf-8'))
    expect(evaluateCodexModels({ registry, expected: list }).ok).toBe(true)
  })
})

// -- the macOS floor (check 4, Electron 44 needs macOS 13) --
describe('release-gate macOS floor', () => {
  const clean = () => fakeGitHub([{ number: 7, title: '2.1.0-beta.17' }], { 7: [] })
  const gate = (version: string, electronVersion: string | undefined, macosFloors: unknown = FLOORS) =>
    evaluateMacosFloor({ version, electronVersion, floors: macosFloors })

  it('an Electron 44 build is refused under a tag whose floor is below macOS 13: the updater would offer it to Macs that cannot open it', () => {
    const r = gate('2.1.1-beta.1', '44.5.1')
    expect(r.ok).toBe(false)
    expect(r.needed).toBe(13)
    expect(r.floor).toBe(0)
    expect(r.reason).toMatch(/Electron 44 needs macOS 13, but v2\.1\.1-beta\.1 has no macOS floor/)
  })

  it('an Electron 44 build passes under a tag at or after the floor, the bare -beta tag release.yml cuts from a final version included', () => {
    for (const v of ['2.1.1-beta.2', '2.1.1-beta.3', '2.1.1-rc.1', '2.1.1', '2.1.1-beta', '2.2.0-beta.1']) {
      const r = gate(v, '44.5.1')
      expect(r.ok, v).toBe(true)
      expect(r.floor, v).toBe(13)
    }
  })

  it('an Electron with no floor of its own passes under any tag', () => {
    for (const v of ['2.1.0-beta.17', '2.1.1-beta.1', '2.1.1']) expect(gate(v, '43.7.1').ok, v).toBe(true)
  })

  it('a tag no updater offers (a dev cut) is not held to a floor', () => {
    const r = gate('2.1.1-dev', '44.5.1')
    expect(r.ok).toBe(true)
    expect(r.offered).toBe(false)
  })

  it('a later Electron is held to its own entry', () => {
    const floors = { floors: [...FLOORS.floors, { fromTag: 'v3.0.0-beta.1', electronMajor: 45, macosMajor: 14 }] }
    expect(gate('3.0.0-beta.1', '45.0.0', floors).ok).toBe(true)
    const r = gate('2.9.0', '45.0.0', floors)
    expect(r.ok).toBe(false)
    expect(r.needed).toBe(14)
    expect(r.floor).toBe(13)
  })

  it('FAILS CLOSED when the floors file or the Electron version cannot be read', () => {
    for (const floors of [undefined, null, {}, { floors: [] }, { floors: 'x' }, { floors: [{ fromTag: 'v1.0.0' }] }]) {
      const r = evaluateMacosFloor({ version: '2.1.1-beta.2', electronVersion: '44.5.1', floors })
      expect(r.ok, JSON.stringify(floors)).toBe(false)
      expect(r.reason).toMatch(/resources\/macos-release-floors\.json lists no floors/)
    }
    for (const electron of [undefined, '', 'latest']) {
      const r = gate('2.1.1-beta.2', electron)
      expect(r.ok, String(electron)).toBe(false)
      expect(r.reason).toMatch(/cannot read the Electron version/)
    }
  })

  it('runGate refuses the cut, with a FAIL line, even when everything else is clean', async () => {
    const r = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: clean().listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected: CODEX_EXPECTED, electronVersion: '44.5.1', macosFloors: FLOORS, log: silent })
    expect(r.exitCode).toBe(EXIT_REFUSED)
    const text = r.lines.join('\n')
    expect(text).toMatch(/OK\s+milestone/)
    expect(text).toMatch(/FAIL\s+macOS floor: Electron 44 needs macOS 13, but v2\.1\.0-beta\.17 has no macOS floor/)
    expect(r.lines.at(-1)).toMatch(/^REFUSED/)
  })

  it('runGate says what the floor is when it passes, and refuses a caller that leaves the floor inputs out', async () => {
    const gh = fakeGitHub([{ number: 7, title: '2.1.1-beta.2' }], { 7: [] })
    const ok = await runGate({ version: '2.1.1-beta.2', repo: 'o/r', listAll: gh.listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected: CODEX_EXPECTED, electronVersion: '44.5.1', macosFloors: FLOORS, log: silent })
    expect(ok.exitCode).toBe(EXIT_OK)
    expect(ok.lines.join('\n')).toMatch(/OK\s+macOS floor: v2\.1\.1-beta\.2 needs macOS 13 or later, as Electron 44 does/)
    const left = await runGate({ version: '2.1.0-beta.17', repo: 'o/r', listAll: clean().listAll, registry: REGISTRY_OK, expected: EXPECTED, codexExpected: CODEX_EXPECTED, log: silent })
    expect(left.exitCode).toBe(EXIT_REFUSED)
  })

  it('main reads the Electron version from package.json and the floors from the shipped file', () => {
    expect(resolve(DEFAULT_MACOS_FLOORS_PATH)).toMatch(/resources[\\/]macos-release-floors\.json$/)
    expect(electronVersionOf({ devDependencies: { electron: '44.5.1' } })).toBe('44.5.1')
    expect(electronVersionOf({ dependencies: { electron: '^45.0.0' } })).toBe('^45.0.0')
    expect(electronVersionOf({})).toBeUndefined()
  })

  it('with the real package.json and floors file: this Electron cannot be cut as 2.1.1-beta.1, and can as 2.1.1-beta.2, 2.1.1-beta and 2.1.1', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf-8'))
    const floors = JSON.parse(readFileSync(DEFAULT_MACOS_FLOORS_PATH, 'utf-8'))
    const electronVersion = electronVersionOf(pkg)
    expect(parseInt(String(electronVersion), 10)).toBeGreaterThanOrEqual(44)
    expect(evaluateMacosFloor({ version: '2.1.1-beta.1', electronVersion, floors }).ok).toBe(false)
    for (const v of ['2.1.1-beta.2', '2.1.1-beta', '2.1.1']) expect(evaluateMacosFloor({ version: v, electronVersion, floors }).ok, v).toBe(true)
  })
})

// ── plumbing ───────────────────────────────────────────────────────
describe('release-gate plumbing', () => {
  it('githubListAll paginates until a short page and sends the bearer token', async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = []
    const pages: Record<string, unknown[]> = { '1': Array.from({ length: 2 }, (_, i) => ({ n: i })), '2': [{ n: 2 }] }
    const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, auth: init.headers.Authorization })
      const page = new URL(url).searchParams.get('page') ?? '1'
      return { ok: true, status: 200, json: async () => pages[page] ?? [] }
    }
    const all = await githubListAll('/repos/o/r/milestones?state=all', { token: 't0k', fetchImpl: fetchImpl as unknown as typeof fetch, perPage: 2 })
    expect(all).toHaveLength(3)
    expect(seen.map((s) => s.url)).toEqual([
      'https://api.github.com/repos/o/r/milestones?state=all&per_page=2&page=1',
      'https://api.github.com/repos/o/r/milestones?state=all&per_page=2&page=2',
    ])
    expect(seen[0].auth).toBe('Bearer t0k')
  })

  it('githubListAll throws on a non-2xx (so the gate reports CANNOT EVALUATE, never pass)', async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) })
    await expect(githubListAll('/repos/o/r/milestones', { token: null, fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow(/401/)
  })

  it('resolveToken prefers GITHUB_TOKEN, then GH_TOKEN, then `gh auth token`', () => {
    expect(resolveToken({ GITHUB_TOKEN: 'a', GH_TOKEN: 'b' }, () => 'c')).toBe('a')
    expect(resolveToken({ GH_TOKEN: 'b' }, () => 'c')).toBe('b')
    expect(resolveToken({}, () => 'c\n')).toBe('c')
    expect(resolveToken({}, () => { throw new Error('no gh') })).toBeNull()
  })

  it('repoFromUrl handles https, ssh and git+https forms', () => {
    expect(repoFromUrl('https://github.com/nubbymong/claude-command-center.git')).toBe('nubbymong/claude-command-center')
    expect(repoFromUrl('git@github.com:nubbymong/claude-command-center.git\n')).toBe('nubbymong/claude-command-center')
    expect(repoFromUrl('git+https://github.com/o/r')).toBe('o/r')
    expect(repoFromUrl('')).toBeNull()
    expect(repoFromPackageJson({ repository: { type: 'git', url: 'https://github.com/o/r.git' } })).toBe('o/r')
    expect(repoFromPackageJson({})).toBeNull()
  })
})

// ── the real fixture and the real registry ─────────────────────────
describe('release-gate shipped fixture', () => {
  const expected = JSON.parse(readFileSync(DEFAULT_EXPECTED_PATH, 'utf-8'))
  const registry = JSON.parse(readFileSync(DEFAULT_REGISTRY_PATH, 'utf-8'))

  it('the fixture is well-formed: source, fetch date, and unique claude-* ids', () => {
    expect(expected.source).toMatch(/^https:\/\/support\.claude\.com\//)
    expect(expected.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const ids = expected.models.map((m: { id: string }) => m.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^claude-[a-z0-9-]+$/)
  })

  it('evaluates the shipped registry without throwing (the verdict itself is the gate\'s business, not this test\'s)', () => {
    // Deliberately NOT asserting ok here: the registry is edited under #385 and
    // the article changes under Anthropic's hand. The release gate is where the
    // verdict bites; this test only proves the real inputs are readable.
    const r = evaluateModels({ registry, expected })
    expect(Array.isArray(r.missing)).toBe(true)
    expect(r.covered.length + r.missing.length).toBe(expected.models.length)
  })

  it('resolves DEFAULT paths to files that exist in the repo', () => {
    expect(resolve(DEFAULT_REGISTRY_PATH)).toMatch(/resources[\\/]model-registry\.json$/)
    // Under resources/ (not scripts/fixtures/) so the packaged app's Sentinel
    // check reads the same snapshot the gate does (#385).
    expect(resolve(DEFAULT_EXPECTED_PATH)).toMatch(/resources[\\/]claude-code-model-configuration\.json$/)
  })
})
