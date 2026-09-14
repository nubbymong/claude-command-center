/**
 * #144 -- the EMISSION SITES must not interpolate a raw model value.
 *
 * READ THIS BEFORE DELETING IT. The first regression guard for #144
 * (spawn-model-flag-quoting.test.ts) tested only the pure helper. Adversarial
 * review reverted BOTH emission sites in pty-manager.ts to the pre-fix
 * `--model ${options.model}` form and the entire suite stayed green --
 * 3239 passed, typecheck clean, no lint error. The bug could regress at any
 * time and CI would say PASS. That was the third vacuous guard in this repo.
 *
 * The helper was never the bug. The CALL SITES were. So this file asserts the
 * property that actually matters and that a unit test on a pure function
 * structurally cannot reach: no spawn site interpolates the model value
 * without going through modelFlag().
 *
 * A source-level assertion is a blunt instrument and is used deliberately --
 * the alternative is extracting the whole flag-assembly block out of two large
 * functions, which is a far larger change than the bug warrants. If that
 * refactor ever happens, replace this with a behavioural assertion on the
 * extracted builder.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { modelFlag } from '../../src/main/spawn-claude-command'

const PTY_MANAGER = path.join(__dirname, '..', '..', 'src', 'main', 'pty-manager.ts')

describe('modelFlag builds the entire flag', () => {
  it('quotes a bracketed 1M id (POSIX)', () => {
    expect(modelFlag('opus[1m]', false)).toBe("--model 'opus[1m]'")
  })

  it('quotes a bracketed 1M id (Windows)', () => {
    expect(modelFlag('opus[1m]', true)).toBe("--model 'opus[1m]'")
  })

  it('returns empty for no model, so a site cannot emit a bare --model', () => {
    expect(modelFlag(undefined, false)).toBe('')
    expect(modelFlag(null, false)).toBe('')
    expect(modelFlag('', false)).toBe('')
  })

  it('never returns an unquoted value', () => {
    for (const m of ['opus', 'opus[1m]', 'sonnet-4.5', 'a.b_c-d[1m]']) {
      const out = modelFlag(m, false)
      expect(out.startsWith("--model '")).toBe(true)
      expect(out.endsWith("'")).toBe(true)
    }
  })
})

describe('no spawn site interpolates the model value raw (#144)', () => {
  const src = fs.readFileSync(PTY_MANAGER, 'utf-8')

  it('pty-manager.ts contains no unquoted --model interpolation', () => {
    // The exact pre-fix shapes, both sites:
    //   `--model ${options.model}`         (SSH, inside the flags array)
    //   ` --model ${options.model}`        (local, appended to extraFlags)
    const raw = /--model\s*\$\{\s*options\??\.model/
    expect(
      raw.test(src),
      'pty-manager.ts interpolates options.model directly into the launch ' +
      'command. That is the #144 bug: on zsh a bracketed 1M id (opus[1m]) is ' +
      'a glob class and aborts the whole line. Use modelFlag().',
    ).toBe(false)
  })

  it('pty-manager.ts still routes the model through modelFlag', () => {
    // Guards the inverse mistake: silencing the check above by deleting the
    // flag altogether rather than quoting it.
    const uses = src.match(/modelFlag\(/g) ?? []
    expect(uses.length, 'expected modelFlag() at both the local and SSH sites').toBeGreaterThanOrEqual(2)
  })
})
