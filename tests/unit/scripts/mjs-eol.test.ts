import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// A `.mjs` script that starts with a hashbang must be checked out LF. Under CRLF
// -- which is what a Windows checkout with core.autocrlf produces, the CI runner
// included -- Vite's hashbang pattern (`/^#!.*\n/`) does not match the first line,
// Vite inserts its own code ahead of the `#!`, and a test that imports the script
// fails to load with "SyntaxError: Invalid or unexpected token" (#207).
// .gitattributes pins them, and its first glob, `scripts/*.mjs`, did not cross
// into scripts/wp1/: the WP1 ledger gate failed to load on the Windows runner
// only, and nowhere a developer runs the suite (PR #619). The line endings of a
// working copy say nothing about this, so the rule is asserted by ATTRIBUTE,
// which fails on every platform the moment a script escapes it.

const ROOT = resolve(__dirname, '..', '..', '..')
const git = (args: string[]): string => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' })

describe('hashbang .mjs scripts are checked out LF on every platform', () => {
  it('every tracked .mjs under scripts/, at any depth, that starts with #! resolves eol=lf', () => {
    const tracked = git(['ls-files', '-z', '--', 'scripts']).split('\0').filter((f) => f.endsWith('.mjs'))
    const hashbang = tracked.filter((f) => readFileSync(resolve(ROOT, f), 'utf8').startsWith('#!'))
    // An empty list would make the check below vacuous (and `check-attr` with no
    // path exits 129), so say so rather than let an unrelated assertion catch it.
    expect(hashbang.length, 'no tracked hashbang .mjs under scripts/ -- the check would be vacuous').toBeGreaterThan(0)
    // The case that escaped the first glob stays in the set this test covers.
    expect(hashbang.some((f) => f.startsWith('scripts/wp1/')), 'no hashbang script under scripts/wp1/ was found').toBe(true)
    // `check-attr -z` prints path, attribute, value, each NUL-terminated.
    const fields = git(['check-attr', '-z', 'eol', '--', ...hashbang]).split('\0')
    const unpinned: string[] = []
    for (let i = 0; i + 2 < fields.length; i += 3) if (fields[i + 2] !== 'lf') unpinned.push(`${fields[i]}: eol ${fields[i + 2]}`)
    expect(unpinned, `these scripts would be checked out CRLF on Windows and fail to load under vitest:\n${unpinned.join('\n')}`).toEqual([])
  })
})
