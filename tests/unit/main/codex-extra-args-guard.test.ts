/**
 * P3.11 (row 62): a Codex session's extra CLI arguments at the spawn boundary,
 * driven through the REAL pty:spawn schema and the fail-open restore sanitizer
 * (never a mirror of them).
 *
 * Parity with Claude's field: the same character guard (length, charset, no
 * trailing backslash), and the flags the app sets refused whole, as Claude's
 * refuses --model, --settings and the rest. For Codex that is the model, every
 * -c setting (the app delivers its effort, MCP server and hooks through -c, as
 * Claude's through --settings), the permission flags, the working folder, the
 * resume selection, and anything that changes the account, provider or
 * endpoint; in any spelling. A plain lowercase word is refused too: Codex reads
 * one in the first-argument place as one of its commands (login, logout, ...).
 */
import { describe, it, expect, vi } from 'vitest'
import { spawnOptionsSchema } from '../../../src/main/ipc/pty-handlers'
import { sanitizeRestoredSpawnOptions, codexExtraArgsProblem, codexExtraArgWords } from '../../../src/main/sanitize-restored-spawn-options'

const codex = (extraArgs: unknown) => ({
  cwd: 'C:/work', provider: 'codex', codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard', extraArgs },
})
const accepts = (v: unknown): boolean => spawnOptionsSchema.safeParse(codex(v)).success
const refusal = (v: unknown): string => {
  const r = spawnOptionsSchema.safeParse(codex(v))
  return r.success ? '' : r.error.message
}

describe('Codex extra CLI arguments: what passes (as Claude\'s field, the flags the app does not set)', () => {
  const ok = [
    '',
    '   ',
    '--search',
    '--add-dir /srv/shared',
    '--add-dir F:\\shared_libs',
    '--add-dir=docs',
    '--add-dir ./docs',
    '--add-dir .\\docs',
    '-i shot.png',
    '--image=a.png,b.png',
    '--no-alt-screen --strict-config',
    '--worktree',
    '-h',
    '-V',
    '--all',
    '--add-dir /srv/a  --add-dir /srv/b',
    '--add-dir 2026',
  ]
  for (const v of ok) {
    it(`takes ${JSON.stringify(v)}`, () => {
      expect(refusal(v)).toBe('')
      expect(codexExtraArgsProblem(v)).toBeNull()
    })
  }
})

describe('Codex extra CLI arguments: the flags the app sets, and account, provider and endpoint settings, are refused in any spelling', () => {
  const managed = [
    // model
    '--model=gpt-5', '--model gpt-5.5', '-m gpt-5.5', '-mgpt-5.5', '-m=gpt-5.5', '-M x.y',
    // every -c setting (effort, MCP, hooks, sandbox, provider, endpoint all ride -c)
    '-c model_reasoning_effort=high', '--config=sandbox_mode=x', '--config model_provider=x', '-cmodel=x', '-C=x',
    '--enable=x_y', '--disable=x_y', '--enable x_y',
    // permissions
    '--sandbox=danger-full-access', '-s=x', '-s x.y', '--ask-for-approval=never', '-a=never', '--approve-for-me',
    '--full-auto', '--yolo', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust',
    '--dangerously-anything-else',
    // resume selection
    '--last',
    // the working folder
    '--cd=/tmp', '--cd /tmp', '-C /tmp',
    // account, provider, endpoint, config profile
    '--profile=work', '-p=work', '-p x.y', '--oss', '--local-provider=x_y', '--remote=ws://h:1', '--remote-auth-token-env=X_Y',
    // a name that starts with a managed one (as Claude's \b rule), a shortened one, another case, a backslash
    '--model-provider=x', '--remote-control', '--sand=x', '--s', '--l', '--SANDBOX=x', '--Model=x', '--mo\\del=x', '\\--model=x',
    // clusters and attached values of short options
    '-hm', '-ix.png', '-1',
    // separators and malformed names
    '-', '--', '---model', '--=x',
    // anywhere in the list, not only first
    '--search --model=x', '--add-dir /srv --yolo',
  ]
  for (const v of managed) {
    it(`refuses ${JSON.stringify(v)}`, () => {
      expect(accepts(v)).toBe(false)
      expect(codexExtraArgsProblem(v)).not.toBeNull()
    })
  }
})

describe('Codex extra CLI arguments: a plain word is refused, since Codex would read it as one of its commands', () => {
  const words = ['login', 'logout', 'resume', 'fork', 'mcp', 'exec', 'e', 'a', 'update', 'app-server', 'mcp-server', 'Login', 'log\\in', 'x1-y',
    '--search logout', '--add-dir docs', '--no-alt-screen login --search']
  for (const v of words) {
    it(`refuses ${JSON.stringify(v)}`, () => {
      expect(accepts(v)).toBe(false)
      expect(codexExtraArgsProblem(v)).toMatch(/one of its commands/)
    })
  }
  it('says how to give a folder named that way instead', () => {
    expect(codexExtraArgsProblem('--add-dir docs')).toMatch(/--add-dir=docs/)
    expect(codexExtraArgsProblem('--add-dir docs')).toMatch(/starts with \.\/ or ends with \//)
  })
})

describe('Codex extra CLI arguments: a word shaped like one of its slash commands is refused, since a word that is not a flag is its opening prompt', () => {
  for (const v of ['/logout', '/model', '/permissions', '/LOGOUT', '\\/logout', '--search /login', '--add-dir /srv']) {
    it(`refuses ${JSON.stringify(v)}`, () => {
      expect(accepts(v)).toBe(false)
      expect(codexExtraArgsProblem(v)).toMatch(/one of its commands/)
    })
  }
  for (const v of ['--add-dir /srv/', '--add-dir /srv/shared', '--add-dir=/srv', '--add-dir docs/', '--add-dir ./docs']) {
    it(`takes ${JSON.stringify(v)}`, () => {
      expect(codexExtraArgsProblem(v)).toBeNull()
      expect(accepts(v)).toBe(true)
    })
  }
})

describe('Codex extra CLI arguments: the same character guard as Claude\'s field', () => {
  it('refuses a shell or cmd.exe character, a trailing backslash, and a value over the cap', () => {
    for (const v of ['--add-dir a;b', '--add-dir $HOME', '--add-dir "x y"', '--add-dir a%b', '--add-dir a&b', '--add-dir (x)', '--add-dir a|b', '--add-dir C:\\x\\', '--add-dir a\tb', '--add-dir a\nb', `--add-dir ./${'x'.repeat(520)}`]) {
      expect(accepts(v), JSON.stringify(v)).toBe(false)
      expect(codexExtraArgsProblem(v), JSON.stringify(v)).not.toBeNull()
    }
  })
  it('refuses a value that is not text', () => {
    for (const v of [7, null, ['--search'], {}]) expect(accepts(v), JSON.stringify(v)).toBe(false)
    expect(codexExtraArgsProblem(7)).not.toBeNull()
  })
})

describe('the refusal says which argument and why', () => {
  it('names the argument in the schema\'s message', () => {
    expect(refusal('--search --sandbox=danger-full-access')).toMatch(/--sandbox=danger-full-access/)
    expect(refusal('--add-dir docs')).toMatch(/docs/)
  })
})

describe('Claude\'s field is unchanged', () => {
  it('a Claude session keeps its own rule: a plain word passes, its own managed flags do not', () => {
    expect(spawnOptionsSchema.safeParse({ extraArgs: '--add-dir docs' }).success).toBe(true)
    expect(spawnOptionsSchema.safeParse({ extraArgs: '--settings x.json' }).success).toBe(false)
  })
  it('Claude\'s top-level field never takes the Codex rule, and the Codex field never takes Claude\'s list alone', () => {
    // -c is Claude's --continue: Claude's field has always taken it.
    expect(spawnOptionsSchema.safeParse({ extraArgs: '-c' }).success).toBe(true)
    expect(accepts('-c')).toBe(false)
  })
})

describe('words: one launch argument each', () => {
  it('splits on spaces, with no empty argument', () => {
    expect(codexExtraArgWords('  --add-dir   /srv/a --search ')).toEqual(['--add-dir', '/srv/a', '--search'])
    expect(codexExtraArgWords('')).toEqual([])
    expect(codexExtraArgWords('   ')).toEqual([])
  })
})

describe('a restored Codex session with extra arguments the schema refuses launches without them, as a Claude one does', () => {
  it('drops them (logged), keeps the rest, and the strict parse then passes', () => {
    for (const bad of ['--model=x', 'login', '--add-dir a;b', 7, '--add-dir C:\\x\\']) {
      const log = vi.fn()
      const out = sanitizeRestoredSpawnOptions({ provider: 'codex', codexOptions: { model: 'gpt-5.5', permissionsPreset: 'auto', extraArgs: bad } }, log)
      expect(out.codexOptions.extraArgs, JSON.stringify(bad)).toBeUndefined()
      expect(out.codexOptions.model).toBe('gpt-5.5')
      expect(out.codexOptions.permissionsPreset).toBe('auto')
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/extra CLI arguments/))
      expect(() => spawnOptionsSchema.parse({ cwd: 'C:/work', ...out })).not.toThrow()
    }
  })
  it('keeps valid ones', () => {
    const out = sanitizeRestoredSpawnOptions({ provider: 'codex', codexOptions: { permissionsPreset: 'standard', extraArgs: '--search --add-dir /srv/x' } })
    expect(out.codexOptions.extraArgs).toBe('--search --add-dir /srv/x')
  })
  it('a Codex leftover on a Claude session is dropped the same way, so it cannot stop that session', () => {
    const out = sanitizeRestoredSpawnOptions({ provider: 'claude', codexOptions: { permissionsPreset: 'standard', extraArgs: '--yolo' } })
    expect(out.codexOptions?.extraArgs).toBeUndefined()
    expect(() => spawnOptionsSchema.parse({ cwd: 'C:/work', ...out })).not.toThrow()
  })
})
