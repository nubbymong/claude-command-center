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
import { describe, it, expect, vi } from 'vitest'
import { spawnOptionsSchema } from '../../../src/main/ipc/pty-handlers'
import { sanitizeRestoredSpawnOptions } from '../../../src/main/sanitize-restored-spawn-options'

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

describe('extraArgs: an option the app sets is refused in any spelling, and so is a word claude reads as a command', () => {
  const refused = [
    '-r', '-R', '-c', '-p', '-w', '-r=11111111-1111-1111-1111-111111111111', '-cp',
    '--session-id=11111111-1111-1111-1111-111111111111', '--fork-session', '--continue', '--resum',
    '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--permission-prompt-tool=x',
    '--setting-sources=user', '--strict-mcp-config', '--plugin-dir=x', '--print', '--output-format=json',
    'mcp', 'update', '/logout', '--verbose /model', '@home',
    // shown in the CLI's help or not: the conversation, where or how it runs, the settings it reads
    '--agent=x', '--agent-id=x', '--prefill-b64=eA', '--messaging-socket-path=x', '--channels=x', '--watch-artifact=x',
    '--deep-link-origin', '--deep-link-cwd-b64=eA', '--handle-uri=x', '--await-claim', '--daemon-worker', '--update',
    '--safe-mode', '--bare', '--client-data-url=https://example.test/c',
    // a word that names a server for the session to run on
    'cc://server.example:8443', '--verbose cc+unix:///tmp/s.sock', 'cc\\://server.example', 'CC://server.example',
  ]
  for (const v of refused) {
    it(`the spawn schema refuses ${JSON.stringify(v)}`, () => {
      expect(accepts(v)).toBe(false)
    })
  }
})

describe('the spawn schema answers a refused value with what the rule refuses', () => {
  const MESSAGE = 'extraArgs must not include an option the app sets (or one that changes the conversation, where or how it runs, its permission mode or the settings it reads), a word Claude reads as a command or as a server address, or a word that starts or ends with a comma, nor end in a backslash'
  for (const v of ['--settings x', '--bare', 'mcp', 'cc://server.example', '--verbose\\', '--verbose x,']) {
    it(`the message for ${JSON.stringify(v)} names the rule`, () => {
      const r = spawnOptionsSchema.safeParse({ extraArgs: v })
      expect(r.success).toBe(false)
      expect(r.success ? [] : r.error.issues.map((i) => i.message)).toContain(MESSAGE)
    })
  }
})

describe('a restored Claude session whose saved extra arguments the rule refuses starts without them', () => {
  it('drops a short resume alias (logged), keeps the rest, and the strict parse then passes', () => {
    for (const bad of ['-r', '--verbose -r 11111111-1111-1111-1111-111111111111', '-c', '--session-id=11111111-1111-1111-1111-111111111111', 'mcp', '/logout',
      '--deep-link-origin --deep-link-cwd-b64=eA', '--verbose --safe-mode']) {
      const log = vi.fn()
      const out = sanitizeRestoredSpawnOptions({ cwd: 'C:/work', model: 'opus', permissionMode: 'plan', extraArgs: bad }, log)
      expect(out.extraArgs, bad).toBeUndefined()
      expect(out.model).toBe('opus')
      expect(out.permissionMode).toBe('plan')
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/dropping invalid persisted extraArgs/))
      expect(() => spawnOptionsSchema.parse(out)).not.toThrow()
    }
  })
  it('drops a saved word that names a server for the session to run on (logged), and the strict parse then passes', () => {
    for (const bad of ['cc://server.example:8443', '--verbose cc+unix:///tmp/s.sock', '--add-dir=docs c\\c://server.example']) {
      const log = vi.fn()
      const out = sanitizeRestoredSpawnOptions({ cwd: 'C:/work', model: 'opus', extraArgs: bad }, log)
      expect(out.extraArgs, bad).toBeUndefined()
      expect(out.model).toBe('opus')
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/dropping invalid persisted extraArgs/))
      expect(() => spawnOptionsSchema.parse(out)).not.toThrow()
    }
  })
  it('drops a saved word that starts or ends with a comma (logged), as the spawn schema refuses it', () => {
    for (const bad of [',--resume', '--verbose ,--permission-mode=bypassPermissions', 'x, --verbose', '--add-dir=docs,']) {
      expect(spawnOptionsSchema.safeParse({ extraArgs: bad }).success, bad).toBe(false)
      const log = vi.fn()
      const out = sanitizeRestoredSpawnOptions({ cwd: 'C:/work', model: 'opus', extraArgs: bad }, log)
      expect(out.extraArgs, bad).toBeUndefined()
      expect(out.model).toBe('opus')
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/dropping invalid persisted extraArgs/))
      expect(() => spawnOptionsSchema.parse(out)).not.toThrow()
    }
    expect(sanitizeRestoredSpawnOptions({ extraArgs: '--allowedTools=Bash,Edit' }).extraArgs).toBe('--allowedTools=Bash,Edit')
  })
  it('keeps saved extra arguments the rule takes', () => {
    for (const ok of ['--verbose', '--add-dir=docs', '--debug=api,hooks --ide', '--add-dir /home/me/project',
      '--add-dir C:\\Users\\me\\project', '--add-dir D:/work']) {
      expect(sanitizeRestoredSpawnOptions({ extraArgs: ok }).extraArgs).toBe(ok)
    }
  })
})

// ADR-009 adversarial review (Lens B/D): pty-manager reads a TOP-LEVEL
// `options.elevated` to wrap a launch in sudo/gsudo. It was declared only under
// terminalOptions, so the schema neither validated nor even saw a top-level
// `elevated` -- an undeclared field a compromised renderer could set to any
// value, and the handler forwards the raw options object. Declaring it means a
// non-boolean is now rejected at the IPC gate rather than flowing through.
describe('ADR-009: the top-level elevated flag is schema-validated', () => {
  it('accepts a boolean', () => {
    expect(spawnOptionsSchema.safeParse({ elevated: true }).success).toBe(true)
    expect(spawnOptionsSchema.safeParse({ elevated: false }).success).toBe(true)
  })
  it('rejects a non-boolean (7ef62a2e: undeclared, so it parsed and the raw value flowed on)', () => {
    expect(spawnOptionsSchema.safeParse({ elevated: 'yes' }).success).toBe(false)
    expect(spawnOptionsSchema.safeParse({ elevated: 1 }).success).toBe(false)
    expect(spawnOptionsSchema.safeParse({ elevated: { toString: () => 'x' } }).success).toBe(false)
  })
})
