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

describe('extraArgs rejects bracket-glob-spelled managed flags', () => {
  // Same substitution as the backslash family, reached a different way. `[` and
  // `]` are in the charset, and an unquoted bracket group is a PATHNAME GLOB: a
  // POSIX shell expands `--setting[s]` to a file literally named `--settings`
  // when one exists in the session's cwd (a cloned repo can ship one), handing
  // the CLI the real flag. Verified in a real shell -- with the file present
  // bash yields ARG=[--settings]; with it absent the pattern stays literal.
  const bypasses = [
    '--setting[s] /tmp/evil-hooks.json',
    '--[m]odel evil-model',
    '--mode[l] evil-model',
    '--agent[s] /tmp/x.json',
    '--resum[e] 11111111-1111-1111-1111-111111111111',
    '--mcp-confi[g] /tmp/x.json',
    '--permission-mod[e] bypassPermissions',
    '--eff[o]rt xhigh',
    // brackets and backslashes combined, since the two collapses share a pass
    '--sett[i]ng\\s /tmp/x.json',
  ]
  for (const v of bypasses) {
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
    // Brackets are collapsed for MATCHING only, never for emission, so a path
    // that legitimately contains them is still accepted.
    '--add-dir /home/me/proj[1]',
    '',
  ]
  for (const v of ok) {
    it(`accepts ${JSON.stringify(v)}`, () => {
      expect(accepts(v)).toBe(true)
    })
  }
})
