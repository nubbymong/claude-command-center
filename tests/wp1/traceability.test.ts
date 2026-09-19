// WP1.70 / WP1.73: bidirectional traceability between the 73 acceptance items
// and the tests/evidence that prove them. Structural rules apply in every
// phase; completeness rules (nothing planned, evidence records digest-bound to
// a commit that is an ancestor of HEAD with no source or test change since)
// apply once the phase is DECLARED candidate (env or manifest; see ./phase.ts).
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { resolvePhaseDetailed } from './phase'

const ROOT = resolve(__dirname, '..', '..')
type Item = {
  id: string; title: string; kind: string; tests: string[]; evidence: string[]; status: 'planned' | 'evidenced'
  reason?: string; currentTests?: string[]; baseCoverage?: string
  evidenceRecords?: Array<{ artifact: string; sha256: string; actor: string; at: string; commands: string[]; runId?: string }>
}
const manifest = JSON.parse(readFileSync(resolve(__dirname, 'traceability.json'), 'utf8')) as {
  schema: string; phase: 'gate0' | 'candidate'; boundHead: string | null; designDigest: string; items: Item[]
}
const ledger = JSON.parse(readFileSync(resolve(__dirname, 'legacy-codex-ledger.json'), 'utf8')) as {
  entries: Array<{ path: string; category: string; disposition: string; evidence: string }>
}
const { phase, reason } = resolvePhaseDetailed(undefined, { eager: false })
const KINDS = new Set(['automated', 'manual-gate', 'packaged', 'real-cli', 'document', 'ci'])
// Exactly what vitest.config.ts collects (tests/integration has no .tsx glob;
// *.native.test.* is excluded from the system-Node run).
const RUNNABLE = /^tests\/(unit|wp1)\/.+\.test\.tsx?$|^tests\/integration\/.+\.test\.ts$/
const NATIVE = /\.native\.test\.tsx?$/
const E2E = /^tests\/e2e\/.+\.spec\.ts$/

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}
const nonEmpty = (p: string) => existsSync(resolve(ROOT, p)) && statSync(resolve(ROOT, p)).size > 0
const sha256 = (p: string) => createHash('sha256').update(readFileSync(resolve(ROOT, p))).digest('hex')
const byId = new Map(manifest.items.map((i) => [i.id, i]))

describe('WP1 traceability manifest', () => {
  it('has exactly WP1.1 .. WP1.73, unique and contiguous, and is bound to the reviewed design digest', () => {
    const ids = manifest.items.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(Array.from({ length: 73 }, (_, i) => `WP1.${i + 1}`))
    expect(manifest.designDigest).toBe('e4d5b99a562952694be034ed8e71db6da379d8cb15bb24df6c2ca3f02cd83140')
  })

  it('every item names at least one test or evidence record, a known kind, a reason when not automated, and its base coverage', () => {
    for (const i of manifest.items) {
      expect(KINDS.has(i.kind), `${i.id} kind ${i.kind}`).toBe(true)
      expect(i.tests.length + i.evidence.length, `${i.id} has no test or evidence link`).toBeGreaterThan(0)
      if (i.kind !== 'automated') expect((i.reason ?? '').length, `${i.id} (${i.kind}) needs a reason why automation is not safe or possible`).toBeGreaterThanOrEqual(10)
      expect(Array.isArray(i.currentTests), `${i.id} must state currentTests (empty when the base has none)`).toBe(true)
      if (i.currentTests!.length === 0) expect((i.baseCoverage ?? '').length, `${i.id} has no currentTests and no baseCoverage reason`).toBeGreaterThanOrEqual(4)
    }
  })

  it('every listed test path is one vitest collects or an e2e spec; an automated item has at least one collected test', () => {
    for (const i of manifest.items) {
      for (const t of i.tests) {
        expect((RUNNABLE.test(t) && !NATIVE.test(t)) || E2E.test(t), `${i.id}: ${t} is outside the vitest include globs and is not an e2e spec`).toBe(true)
      }
      if (i.kind === 'automated') expect(i.tests.some((t) => RUNNABLE.test(t) && !NATIVE.test(t)), `${i.id} is automated but lists no vitest-collected test`).toBe(true)
      for (const t of i.currentTests ?? []) expect(nonEmpty(t), `${i.id}: currentTests ${t} missing on disk`).toBe(true)
    }
  })

  it('a documentation file the ledger schedules for a rewrite is listed as evidence by every WP1 item its entry cites', () => {
    for (const e of ledger.entries.filter((x) => x.category === 'DOCS' && x.disposition !== 'retain')) {
      for (const id of e.evidence.match(/WP1\.\d+/g) ?? []) {
        const item = byId.get(id)
        expect(item, `${e.path} cites unknown ${id}`).toBeDefined()
        expect(item!.evidence, `${id} does not list ${e.path} (cited by its ledger entry)`).toContain(e.path)
      }
    }
  })

  it('evidenced items point at non-empty files that name the item, with digest-bound evidence records', () => {
    for (const i of manifest.items) {
      if (i.status !== 'evidenced') continue
      for (const t of i.tests) {
        expect(nonEmpty(t), `${i.id}: missing or empty ${t}`).toBe(true)
        if (t.startsWith('tests/wp1/')) expect(new RegExp(`${i.id.replace('.', '\\.')}(?![0-9])`).test(readFileSync(resolve(ROOT, t), 'utf8')), `${t} does not name ${i.id}`).toBe(true)
      }
      for (const e of i.evidence) {
        expect(nonEmpty(e), `${i.id}: missing or empty ${e}`).toBe(true)
        if (e.startsWith('docs/wp1/evidence/')) {
          const rec = (i.evidenceRecords ?? []).find((r) => r.artifact === e)
          expect(rec, `${i.id}: no evidence record for ${e}`).toBeDefined()
          expect(rec!.sha256).toBe(sha256(e))
          expect(rec!.actor.length).toBeGreaterThan(0)
          expect(Number.isNaN(Date.parse(rec!.at))).toBe(false)
          expect(rec!.commands.length).toBeGreaterThan(0)
        }
      }
    }
  })

  it('every WP1 test file is named by at least one item (no dangling tests)', () => {
    const named = new Set(manifest.items.flatMap((i) => i.tests))
    for (const f of walk(resolve(__dirname))) {
      const rel = f.replace(/\\/g, '/').slice(ROOT.replace(/\\/g, '/').length + 1)
      expect(named.has(rel), `${rel} is not named by any WP1.* item`).toBe(true)
      expect(/WP1\.\d+/.test(readFileSync(f, 'utf8')), `${rel} names no WP1.* requirement`).toBe(true)
    }
  })

  it(`candidate phase: nothing is still planned and evidence is bound to a commit that is an ancestor of HEAD with no source or test change since (phase ${phase}: ${reason})`, () => {
    if (phase !== 'candidate') return
    const planned = manifest.items.filter((i) => i.status !== 'evidenced').map((i) => i.id)
    expect(planned, `planned items at candidate phase: ${planned.join(', ')}`).toEqual([])
    expect(manifest.boundHead).toMatch(/^[0-9a-f]{40}$/)
    let ancestor = true
    try { execFileSync('git', ['-C', ROOT, 'merge-base', '--is-ancestor', manifest.boundHead!, 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'] }) } catch { ancestor = false }
    expect(ancestor, `boundHead ${manifest.boundHead} is not an ancestor of HEAD`).toBe(true)
    const changed = execFileSync('git', ['-C', ROOT, 'diff', '--name-only', `${manifest.boundHead}..HEAD`, '--', 'src', 'scripts', 'tests', 'package.json'], { encoding: 'utf8' }).trim()
    expect(changed, `source or tests changed after evidence collection; regenerate the affected records:\n${changed}`).toBe('')
  })
})
