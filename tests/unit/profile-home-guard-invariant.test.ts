import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

// The fourth resolver was missed. Three sites were fixed —
// resolveInsightsAccount, resolveHeadlessProfileHome and the cloud-agent env
// builder — while `spawnPty` had the identical shape inline rather than as a named
// function, and `pty:spawn` types profileId as `z.string().optional()`, which
// checks the type and not the charset. So a renderer-supplied `../x` reached
// getProfileConfigDir's throw on the most-used IPC path in the app.
//
// A behavioural test of spawnPty would need the whole electron + node-pty mock
// stack, and refactoring the session-spawn hot path to make it injectable is not
// worth the risk for a one-line guard. So this asserts the INVARIANT instead,
// which is what actually failed: nobody noticed a fifth site could appear.
//
// Same shape as the `Win32_Process` assertion in vision-browser-teardown.test.ts:
// a source-level guard against silently reintroducing a pattern.

const SRC = join(__dirname, '..', '..', 'src', 'main')

/** Every `existsSync(getProfileConfigDir(x))` in src/main, with its file+line. */
function findHomeExistenceChecks(): Array<{ file: string; line: number; text: string; id: string }> {
  const out: Array<{ file: string; line: number; text: string; id: string }> = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.endsWith('.ts')) continue
      const lines = readFileSync(full, 'utf-8').split('\n')
      lines.forEach((text, i) => {
        // `existsSync(getProfileConfigDir(<identifier>))` — the resolver shape.
        // A member expression (`p.id`) is provenance-safe: it came from
        // listProfiles()/createProfile(), so it is deliberately not matched.
        const m = /existsSync\(\s*getProfileConfigDir\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\)/.exec(text)
        if (m) out.push({ file: full.slice(SRC.length + 1), line: i + 1, text: text.trim(), id: m[1] })
      })
    }
  }
  walk(SRC)
  return out
}

describe('profile-home existence checks validate the id before joining it', () => {
  const checks = findHomeExistenceChecks()

  it('finds the resolver sites at all — the scan must not pass vacuously', () => {
    // Guards the guard: if the regex stops matching (a refactor renames the call,
    // or reformats it across lines), this test would otherwise report success
    // while checking nothing. Four sites are known today.
    expect(checks.length).toBeGreaterThanOrEqual(4)
  })

  it('validates every caller-supplied id on the same expression', () => {
    // An id is acceptable if it is validated on the spot, OR its provenance is the
    // profile store itself — `getPrimaryProfileId()` can only return an id that
    // listProfiles() produced, so re-validating it would be noise. Provenance is
    // checked rather than exempting the *name* `primary`, so renaming the variable
    // cannot smuggle an unvalidated id past this.
    const unguarded = checks.filter((c) => {
      if (new RegExp(`isValidProfileId\\(\\s*${c.id}\\s*\\)`).test(c.text)) return false
      const source = readFileSync(join(SRC, c.file), 'utf-8')
      const fromStore = new RegExp(`${c.id}\\s*=\\s*(?:await\\s+)?getPrimaryProfileId\\(`).test(source)
      return !fromStore
    })
    expect(
      unguarded.map((c) => `${c.file}:${c.line} -> ${c.text}`),
      'each of these joins a caller-supplied profile id into a path without validating it first, ' +
        'and without provenance from the profile store; getProfileConfigDir will throw, and the ' +
        'resolver should warn and fall back to primary instead'
    ).toEqual([])
  })

  it('covers the four known resolver sites', () => {
    const files = [...new Set(checks.map((c) => c.file.replace(/\\/g, '/')))]
    for (const expected of ['pty-manager.ts', 'insights-runner.ts', 'cloud-agent-manager.ts', 'account-profiles.ts']) {
      expect(files.some((f) => f.endsWith(expected)), `${expected} should contain a profile-home existence check`).toBe(true)
    }
  })
})
