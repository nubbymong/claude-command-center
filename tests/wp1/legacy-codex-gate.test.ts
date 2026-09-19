// WP1.57 / WP1.58 / WP1.67 merge gate: the repository-wide legacy Codex
// manifest is re-run on the current tree and checked against the disposition
// ledger in both directions. The predicates live in
// scripts/wp1/legacy-codex-manifest.mjs so the gate and the committed manifest
// cannot drift apart. Every failure direction is proven reachable below with
// SYNTHETIC rows (verify-the-verifier), so the self-test keeps working after
// the live ledger no longer contains a given disposition. The baseline test
// inventory (WP1.33) is checked for silently removed test files, Claude-side
// included.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runManifest, checkLedger, predicateDigest, DISPOSITIONS } from '../../scripts/wp1/legacy-codex-manifest.mjs'
import { resolvePhaseDetailed } from './phase'

const ROOT = resolve(__dirname, '..', '..')
const ledger = JSON.parse(readFileSync(resolve(__dirname, 'legacy-codex-ledger.json'), 'utf8'))
const committed = JSON.parse(readFileSync(resolve(ROOT, 'docs/wp1/legacy-codex-manifest.json'), 'utf8'))
const inventory = JSON.parse(readFileSync(resolve(ROOT, 'docs/wp1/baseline-test-inventory.json'), 'utf8'))
const manifest = runManifest()
const { phase, reason } = resolvePhaseDetailed(ledger)

type Row = { path: string; predicates: string[]; disposition: string; evidence: string; note?: string; adaptsTests?: string[]; newPath?: string; resolved?: boolean; resolvedEvidence?: string }
const GOOD = 'WP1.33 synthetic evidence naming tests/wp1/legacy-codex-gate.test.ts'
const has = (problems: string[], prefix: string) => problems.some((p) => p.startsWith(prefix))
/** A ledger clone whose first live row is replaced by a synthetic row on the
 *  same (present) manifest path, so the fixture never depends on which
 *  dispositions the live ledger happens to hold. */
function withSynthetic(over: Partial<Row>, extra: Row[] = []): typeof ledger {
  const clone = JSON.parse(JSON.stringify(ledger))
  const live = manifest.entries[0]
  const idx = clone.entries.findIndex((e: Row) => e.path === live.path)
  expect(idx, `live ledger has no row for ${live.path}`).toBeGreaterThanOrEqual(0)
  clone.entries[idx] = { path: live.path, predicates: live.predicates, category: 'TEST', disposition: 'retain', evidence: GOOD, note: '', ...over }
  clone.entries.push(...extra)
  return clone
}

describe('WP1 legacy Codex manifest gate', () => {
  it(`every matched path has a decided disposition with evidence; nothing stale, drifted or unscoped (phase ${phase}: ${reason})`, () => {
    const problems = checkLedger(manifest, ledger, { phase })
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('the ledger and the committed manifest are bound to the current predicate set and manifest digest', () => {
    expect(ledger.predicateDigest).toBe(predicateDigest())
    expect(ledger.manifestPathDigest).toBe(manifest.pathDigest)
    expect(committed.predicateDigest).toBe(predicateDigest())
    expect(committed.pathDigest).toBe(manifest.pathDigest)
    expect(committed.matchedPathCount).toBe(manifest.matchedPathCount)
    expect(ledger.manifestHead).toMatch(/^[0-9a-f]{40}$/) // informational breadcrumb, but never a forged shape
  })

  it('uses only the six disposition values the ledger defines, with no duplicate paths', () => {
    expect([...DISPOSITIONS].sort()).toEqual(['added', 'defer', 'delete', 'move', 'replace', 'retain'])
    const paths = ledger.entries.map((e: Row) => e.path)
    expect(new Set(paths).size).toBe(paths.length)
    for (const e of ledger.entries) expect(DISPOSITIONS.has(e.disposition), `${e.path} -> ${e.disposition}`).toBe(true)
  })

  it('the checker can fail in every direction it claims to guard (synthetic rows)', () => {
    const c = (l: typeof ledger, p?: 'gate0' | 'candidate') => checkLedger(manifest, l, { phase: p ?? 'gate0' })
    expect(has(c(withSynthetic({ disposition: 'UNDECIDED' })), 'UNDECIDED')).toBe(true)
    const missing = JSON.parse(JSON.stringify(ledger)); missing.entries.splice(0, 1)
    expect(has(c(missing), 'UNMATCHED')).toBe(true)
    const ghost: Row = { path: 'src/does-not-exist.ts', predicates: ['P01'], disposition: 'retain', evidence: GOOD }
    expect(has(c(withSynthetic({}, [ghost])), 'STALE')).toBe(true)
    expect(has(c(withSynthetic({ evidence: 'x' })), 'VACUOUS EVIDENCE')).toBe(true)
    expect(has(c(withSynthetic({ disposition: 'replace', evidence: 'WP1.99 long enough evidence without any path' })), 'VACUOUS EVIDENCE (non-retain')).toBe(true)
    expect(has(c(withSynthetic({ predicates: ['P99'] })), 'PREDICATE DRIFT')).toBe(true)
    const predSet = withSynthetic({}); predSet.predicateDigest = 'not-the-digest'
    expect(has(c(predSet), 'PREDICATE SET CHANGED')).toBe(true)
    const mdrift = withSynthetic({}); mdrift.manifestPathDigest = 'not-the-digest'
    expect(has(c(mdrift), 'MANIFEST DRIFT')).toBe(true)
    const dup = withSynthetic({}); dup.entries.push({ ...dup.entries[0] })
    expect(has(c(dup), 'DUPLICATE')).toBe(true)
    // CONTRADICTION: a synthetic replace row adapts a test the ledger marks retain.
    const retainedTest: Row = { path: 'tests/synthetic/kept.test.ts', predicates: ['P13'], disposition: 'retain', evidence: GOOD }
    const contra = withSynthetic({ disposition: 'replace', evidence: GOOD, adaptsTests: [retainedTest.path] }, [retainedTest])
    expect(has(c(contra), 'CONTRADICTION')).toBe(true)
    expect(has(c(contra), 'STALE')).toBe(true) // the synthetic retained test path does not exist: also stale, as it should be
    expect(has(c(withSynthetic({ disposition: 'replace', evidence: GOOD, adaptsTests: ['tests/nowhere.test.ts'] })), 'ADAPTED TEST NOT IN LEDGER')).toBe(true)
    // Candidate phase: a delete that still matches is NOT RETIRED; a relocated
    // move whose target does not match is NOT MOVED + MOVE TARGET MISSING.
    expect(has(c(withSynthetic({ disposition: 'delete', evidence: GOOD }), 'candidate'), 'NOT RETIRED')).toBe(true)
    const mv = c(withSynthetic({ disposition: 'move', evidence: GOOD, newPath: 'src/main/providers/codex/nowhere.ts' }), 'candidate')
    expect(has(mv, 'NOT MOVED')).toBe(true)
    expect(has(mv, 'MOVE TARGET MISSING')).toBe(true)
    // A move that announces a relocation in prose needs a newPath.
    expect(has(c(withSynthetic({ disposition: 'move', evidence: GOOD, note: 'the registry moves under providers/core' })), 'RELOCATION WITHOUT NEWPATH')).toBe(true)
    // Terminal state: a replace whose path is gone is STALE unless resolved with real resolvedEvidence.
    const gone: Row = { path: 'docs/synthetic-replaced.md', predicates: ['P12'], disposition: 'replace', evidence: GOOD }
    expect(has(c(withSynthetic({}, [gone])), 'STALE')).toBe(true)
    expect(c(withSynthetic({}, [{ ...gone, resolved: true, resolvedEvidence: GOOD }])).filter((p) => p.includes('synthetic-replaced'))).toEqual([])
    expect(has(c(withSynthetic({}, [{ ...gone, resolved: true, resolvedEvidence: 'x' }])), 'VACUOUS RESOLUTION')).toBe(true)
    expect(has(c(withSynthetic({ disposition: 'replace', evidence: GOOD, resolved: true, resolvedEvidence: GOOD })), 'RESOLVED BUT STILL MATCHES')).toBe(true)
    expect(has(c(withSynthetic({ disposition: 'retain', resolved: true, resolvedEvidence: GOOD })), 'RESOLVED ON WRONG DISPOSITION')).toBe(true)
    // At the candidate a non-retain row must cite paths that exist.
    expect(has(c(withSynthetic({ disposition: 'replace', evidence: 'WP1.33 replacement coverage in tests/wp1/does-not-exist.test.ts' }), 'candidate'), 'EVIDENCE PATH MISSING')).toBe(true)
    expect(has(c(withSynthetic({ disposition: 'replace', evidence: 'WP1.33 replacement coverage in tests/wp1/does-not-exist.test.ts' }), 'gate0'), 'EVIDENCE PATH MISSING')).toBe(false)
    // Manifest-side failures.
    expect(has(checkLedger({ ...manifest, unscopedMentions: ['some/file.txt'] }, ledger), 'UNSCOPED MENTION')).toBe(true)
    expect(has(checkLedger({ ...manifest, unreadable: ['some/file.ts'] }, ledger), 'UNREADABLE')).toBe(true)
  })

  it('WP1.33: every baseline test file still exists, or carries a recorded mapping (Codex ledger or claudeTestChanges)', () => {
    const mapped = new Set<string>([
      ...ledger.entries.filter((e: Row) => e.disposition !== 'retain').map((e: Row) => e.path),
      ...(ledger.claudeTestChanges ?? []).map((e: Row) => e.path),
    ])
    const missing = Object.keys(inventory.files).filter((p) => !existsSync(resolve(ROOT, p)) && !mapped.has(p))
    expect(missing, `baseline test files removed without a mapping:\n${missing.join('\n')}`).toEqual([])
    expect(inventory.head).toBe('6bafcc33c9b9465713376bf6ad9b8b672ae1b890')
    expect(inventory.fileCount).toBeGreaterThan(800)
  })

  it('claudeTestChanges entries name a real baseline test and a WP1.* item', () => {
    for (const c of ledger.claudeTestChanges ?? []) {
      expect(inventory.files[c.path], `${c.path} is not in the baseline inventory`).toBeDefined()
      expect(['replace', 'delete']).toContain(c.disposition)
      expect(c.evidence).toMatch(/WP1\.\d+/)
    }
  })

  it('every Codex fixture file is inside the gate (no text fixture is excluded by extension)', () => {
    for (const f of ['tests/fixtures/codex/rollout-sample.jsonl', 'tests/fixtures/codex/tui-trace.txt', 'tests/fixtures/codex-rollouts/malformed.jsonl']) {
      expect(manifest.entries.some((e) => e.path === f), `${f} is not in the manifest`).toBe(true)
    }
  })
})
