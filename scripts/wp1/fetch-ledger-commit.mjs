#!/usr/bin/env node
// Fetch the ONE commit the WP1 legacy-Codex disposition ledger is bound to.
//
// tests/wp1/legacy-codex-gate.test.ts lists the tree of that commit to tell a
// file WP1 created from one it inherited, and every workflow that runs the unit
// suite checks out at depth 1, which does not carry it (exact-head review: the
// gate failed "not a tree object" on both CI platforms). One script, called by
// every such workflow step, so the fetch cannot be fixed in one workflow and
// forgotten in another -- the release build runs the same suite from the same
// kind of checkout (exact-head review fix, independent spec review).
//
// The SHA comes from a file a PR can edit, so it is format-checked, and git is
// run without a shell: a value such as `--upload-pack=...` never reaches git.
//
//   node scripts/wp1/fetch-ledger-commit.mjs
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const LEDGER = 'tests/wp1/legacy-codex-ledger.json'

if (!existsSync(LEDGER)) {
  console.log(`no ${LEDGER} in this tree; nothing to fetch`)
  process.exit(0)
}
const sha = String(JSON.parse(readFileSync(LEDGER, 'utf8')).manifestHead)
if (!/^[0-9a-f]{40}$/.test(sha)) {
  console.error(`::error::${LEDGER} manifestHead is not a 40-hex commit id`)
  process.exit(1)
}
execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', sha], { stdio: 'inherit' })
// Proves the object the gate reads is now present, not only that fetch exited 0.
execFileSync('git', ['cat-file', '-e', `${sha}^{tree}`], { stdio: 'inherit' })
console.log(`fetched ${sha}`)
