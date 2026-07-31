/**
 * The extraArgs managed-flag refine must survive backslash spellings.
 *
 * The refine exists to stop the escape hatch clobbering CCC's own flags. It
 * matched literal flag text, but the value is emitted UNQUOTED and POSIX shells
 * strip unquoted backslashes at word expansion -- so `--setting\s` matched no
 * literal flag, passed the guard, and arrived at the CLI as the real
 * `--settings`. That substitutes CCC's per-session settings file, and a Claude
 * settings file carries `hooks`, i.e. arbitrary commands.
 *
 * The character itself is NOT banned: Windows users pass backslash paths through
 * this hatch legitimately, and on Windows the launch shell is PowerShell where
 * backslash is not an escape character. The refine collapses backslashes before
 * matching instead.
 */
import { describe, it, expect } from 'vitest'
import { spawnOptionsSchema } from '../../../src/main/ipc/pty-handlers'

// The REAL shipped schema, not a mirror. An earlier draft of this file copied
// the field definition, which meant reverting the fix in the source left every
// case here green -- a vacuous guard, the failure mode this repo has now hit
// three times. Importing the real thing removes the possibility.
const accepts = (v: string): boolean =>
  spawnOptionsSchema.safeParse({ extraArgs: v }).success

describe('extraArgs rejects backslash-spelled managed flags', () => {
  const bypasses = [
    '--setting\\s /tmp/evil-hooks.json',
    '\\--model evil-model',
    '--mo\\del evil-model',
    '--agent\\s /tmp/x.json',
    '--resum\\e 11111111-1111-1111-1111-111111111111',
    '--mcp-confi\\g /tmp/x.json',
    '--permission-mod\\e bypassPermissions',
    '--eff\\ort xhigh',
    // multiple backslashes, and one in the middle of the flag name
    '--se\\tting\\s /tmp/x.json',
  ]
  for (const v of bypasses) {
    it(`rejects ${JSON.stringify(v)}`, () => {
      expect(accepts(v)).toBe(false)
    })
  }

  it('still rejects the plain unescaped spellings', () => {
    expect(accepts('--settings /tmp/x.json')).toBe(false)
    expect(accepts('--model evil')).toBe(false)
  })
})

describe('extraArgs rejects bracket globs outright', () => {
  // Same substitution as the backslash family, reached a different way: the
  // value is emitted unquoted, so an unquoted bracket group is a PATHNAME GLOB.
  // With a file literally named `--settings` in the session's cwd (a cloned
  // repo can ship one) a POSIX shell expands EVERY form below to `--settings`,
  // handing the CLI the real flag. Verified in a real shell.
  //
  // These are rejected by the CHARSET, not by the managed-flag refine, and that
  // distinction is the point. Collapsing brackets the way backslashes are
  // collapsed only defeats the single-character form: a backslash is an escape
  // (deleting it reproduces what the shell yields) but a bracket group is a
  // pattern, so `--setting[r-t]` normalises to `--settingr-t` and matches
  // nothing while still expanding to `--settings`. Banning the character is the
  // only complete answer, and it is available because the charset admits no
  // other glob metacharacter.
  const globs = [
    '--setting[s] /tmp/evil-hooks.json',
    '--setting[r-t] /tmp/evil-hooks.json',   // range class
    '--setting[a-z] /tmp/evil-hooks.json',   // letter range
    '--setting[!x] /tmp/evil-hooks.json',    // negated class
    '--[m]odel evil-model',
    '--mode[k-m] evil-model',
    '--agent[s] /tmp/x.json',
    '--resum[e] 11111111-1111-1111-1111-111111111111',
    '--mcp-confi[g] /tmp/x.json',
    '--permission-mod[e] bypassPermissions',
    '--eff[o]rt xhigh',
    '--sett[i]ng\\s /tmp/x.json',            // brackets + backslash combined
    // A bare bracket carries no managed flag at all, but still globs, so the
    // charset rejects it regardless of what follows.
    '--add-dir /home/me/proj[1]',
  ]
  for (const v of globs) {
    it(`rejects ${JSON.stringify(v)}`, () => {
      expect(accepts(v)).toBe(false)
    })
  }
})

describe('extraArgs rejects a trailing backslash', () => {
  it('rejects it: on SSH it becomes a shell line continuation', () => {
    // The remote shell prompts `>` and swallows the user's next line as
    // arguments; claude never launches.
    expect(accepts('--verbose \\')).toBe(false)
    expect(accepts('x\\')).toBe(false)
  })
})

describe('extraArgs still accepts what it is for', () => {
  const ok = [
    '--verbose',
    '--debug --verbose',
    'C:\\Users\\me\\thing.json',
    '--add-dir C:\\Users\\me\\project',
    '--add-dir /home/me/project',
    '--foo=bar',
    '--tag a,b,c',
    '',
  ]
  for (const v of ok) {
    it(`accepts ${JSON.stringify(v)}`, () => {
      expect(accepts(v)).toBe(true)
    })
  }
})
