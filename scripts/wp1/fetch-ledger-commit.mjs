#!/usr/bin/env node
// Make sure the ONE commit the WP1 legacy-Codex gate reads is in the object
// store: the pre-WP1 baseline named by docs/wp1/baseline-test-inventory.json.
//
// tests/wp1/legacy-codex-gate.test.ts lists that commit's tree to tell a file
// WP1 created from one it inherited, and every workflow that runs the unit
// suite checks out at depth 1, which does not carry it (exact-head review: the
// gate failed "not a tree object" on both CI platforms). One script, called by
// every such workflow step, so the fetch cannot be fixed in one workflow and
// forgotten in another -- the release build runs the same suite from the same
// kind of checkout (exact-head review fix, independent spec review).
//
// It was first pointed at the ledger's `manifestHead`, a commit that moves with
// every re-skeleton; the gate now reads the fixed baseline, which is on beta,
// so nothing depends on GitHub keeping a branch commit reachable (adversarial
// round 8). An object already present is not fetched again, and `--depth=1` is
// passed only to a checkout that is already shallow: in a full clone it would
// have made the repository shallow (adversarial round 8, MINOR).
//
// The SHA comes from a file a PR can edit, so it is format-checked, and git is
// run without a shell: a value such as `--upload-pack=...` never reaches git.
//
//   node scripts/wp1/fetch-ledger-commit.mjs
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const INVENTORY = 'docs/wp1/baseline-test-inventory.json'

if (!existsSync(INVENTORY)) {
  console.log(`no ${INVENTORY} in this tree; nothing to fetch`)
  process.exit(0)
}
const sha = String(JSON.parse(readFileSync(INVENTORY, 'utf8')).head)
if (!/^[0-9a-f]{40}$/.test(sha)) {
  console.error(`::error::${INVENTORY} head is not a 40-hex commit id`)
  process.exit(1)
}
const present = () => {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{tree}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
if (present()) {
  console.log(`${sha} already present`)
  process.exit(0)
}
const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim() === 'true'
execFileSync('git', ['fetch', '--no-tags', ...(shallow ? ['--depth=1'] : []), 'origin', sha], { stdio: 'inherit' })
// Proves the object the gate reads is now present, not only that fetch exited 0.
if (!present()) {
  console.error(`::error::fetched ${sha} but its tree is still not in the object store`)
  process.exit(1)
}
console.log(`fetched ${sha}`)
