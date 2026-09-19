#!/usr/bin/env node
// WP1.33 / 16.4: semantic comparison of a candidate vitest JSON report against
// the digest-bound baseline inventory (docs/wp1/baseline-test-inventory.json).
// A baseline test file that is missing, or whose sorted test names changed, must
// carry a recorded mapping: a non-retain entry in the Codex ledger or a
// claudeTestChanges entry. New files are listed for information. Exit 1 on any
// unmapped removal or change.
//
//   npx vitest run --reporter=json --outputFile=<candidate.json>
//   node scripts/wp1/compare-baseline.mjs <candidate.json>
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const [, , candidatePath] = process.argv
if (!candidatePath) { console.error('usage: compare-baseline.mjs <candidate vitest.json>'); process.exit(2) }

const baseline = JSON.parse(readFileSync(resolve(ROOT, 'docs/wp1/baseline-test-inventory.json'), 'utf8'))
const ledger = JSON.parse(readFileSync(resolve(ROOT, 'tests/wp1/legacy-codex-ledger.json'), 'utf8'))
const candidate = JSON.parse(readFileSync(candidatePath, 'utf8'))

const mapped = new Set([
  ...ledger.entries.filter((e) => e.disposition !== 'retain').map((e) => e.path),
  ...(ledger.claudeTestChanges ?? []).map((e) => e.path),
])
const rel = (abs) => { const n = abs.replace(/\\/g, '/'); const i = n.indexOf('/tests/'); return i >= 0 ? n.slice(i + 1) : n }
const current = new Map()
for (const f of candidate.testResults) {
  const names = f.assertionResults.map((a) => a.fullName).sort()
  current.set(rel(f.name), { tests: names.length, namesSha256: createHash('sha256').update(names.join('\n')).digest('hex') })
}
const problems = []
const changed = []
for (const [p, b] of Object.entries(baseline.files)) {
  const c = current.get(p)
  if (!c) { if (!mapped.has(p)) problems.push(`REMOVED WITHOUT MAPPING: ${p}`); else changed.push(`removed (mapped): ${p}`); continue }
  if (c.namesSha256 !== b.namesSha256) {
    if (!mapped.has(p)) problems.push(`CHANGED WITHOUT MAPPING: ${p} (${b.tests} -> ${c.tests} tests)`)
    else changed.push(`changed (mapped): ${p} (${b.tests} -> ${c.tests} tests)`)
  }
}
const added = [...current.keys()].filter((p) => !baseline.files[p]).sort()
console.log(`baseline ${baseline.fileCount} files @ ${baseline.head.slice(0, 8)}; candidate ${current.size} files`)
console.log(`mapped removals/changes: ${changed.length}`); changed.forEach((l) => console.log('  ' + l))
console.log(`new test files: ${added.length}`); added.forEach((l) => console.log('  + ' + l))
if (problems.length) { console.error(problems.join('\n')); console.error(`\n${problems.length} unmapped baseline change(s)`); process.exit(1) }
console.log('every baseline removal/change carries a recorded mapping')
