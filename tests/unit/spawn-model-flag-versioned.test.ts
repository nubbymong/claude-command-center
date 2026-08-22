/**
 * #385 -- PINNED model ids on a command line.
 *
 * The picker can now hand `--model` a versioned id (`claude-opus-4-6`) instead
 * of a family alias, and a versioned id can itself carry the 1M bracket
 * (`claude-opus-4-6[1m]`, should the CLI accept it). #144 was exactly this
 * failure for `opus[1m]`: `[1m]` is a POSIX glob character class, so an
 * unquoted value is glob-expanded and, under zsh, aborts the whole launch line
 * with "no matches found".
 *
 * spawn-model-flag-emission.test.ts guards pty-manager.ts against the original
 * raw-interpolation shape. This file widens that in two directions the picker
 * change makes load-bearing:
 *   - every id the picker can actually produce survives quoting, and
 *   - EVERY `--model` emission in src/main is accounted for, not just the two
 *     sites in pty-manager.ts (a new file emitting `--model` was unscanned).
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { modelFlag, quoteArgForShell } from '../../src/main/spawn-claude-command'
import { buildModelPickerRows, type ModelRegistry } from '../../src/shared/model-registry'
import baselineJson from '../../resources/model-registry.json'

const MAIN_DIR = path.join(__dirname, '..', '..', 'src', 'main')
const reg = baselineJson as unknown as ModelRegistry

/** The charset the IPC boundary enforces on `model` (pty-handlers.ts). */
const IPC_MODEL_RE = /^[a-zA-Z0-9._[\]-]+$/

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('pinned versioned ids are quoted on every shell path (#385)', () => {
  const pinned = ['claude-opus-4-6', 'claude-opus-4-8', 'claude-sonnet-4-5', 'claude-haiku-4-5']
  const bracketed = ['opus[1m]', 'claude-opus-4-6[1m]', 'claude-opus-5[1m]']

  it('quotes a pinned versioned id on POSIX and Windows', () => {
    for (const id of pinned) {
      expect(modelFlag(id, false)).toBe(`--model '${id}'`)
      expect(modelFlag(id, true)).toBe(`--model '${id}'`)
    }
  })

  it('quotes a versioned 1M id -- the #144 glob class, now with a version', () => {
    for (const id of bracketed) {
      for (const isWin of [false, true]) {
        const out = modelFlag(id, isWin)
        expect(out).toBe(`--model '${id}'`)
        // The brackets must be INSIDE the quotes, never bare on the line.
        expect(/\[1m\](?!')/.test(out.replace(/'[^']*'/g, (s) => s.replace(/[[\]]/g, '_')))).toBe(false)
      }
    }
  })

  it('every model the picker can produce is IPC-legal and quotes safely', () => {
    const rows = buildModelPickerRows(reg)
    expect(rows.length).toBeGreaterThan(5)
    for (const row of rows) {
      expect(IPC_MODEL_RE.test(row.value), `${row.value} would be rejected at the IPC boundary`).toBe(true)
      const q = quoteArgForShell(row.value, false)
      expect(q.startsWith("'") && q.endsWith("'")).toBe(true)
      // No unescaped single quote can escape the quoting.
      expect(q.slice(1, -1).includes("'")).toBe(false)
    }
  })

  it('a value carrying a single quote cannot break out (POSIX and Windows)', () => {
    const nasty = "opus'; rm -rf /; echo '"
    const posix = quoteArgForShell(nasty, false)
    expect(posix).toBe("'opus'\\''; rm -rf /; echo '\\'''")
    const win = quoteArgForShell(nasty, true)
    expect(win.startsWith("'") && win.endsWith("'")).toBe(true)
  })
})

describe('every --model emission in src/main is a known, safe site (#385)', () => {
  const files = walk(MAIN_DIR)

  it('finds no unaccounted-for --model construction', () => {
    const offenders: string[] = []
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf-8')
      src.split('\n').forEach((line, i) => {
        if (!line.includes('--model')) return
        // A comment, a validation message, or an argv-array element is not a
        // shell-string emission.
        const trimmed = line.trim()
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) return
        if (/'--model'/.test(line)) return                    // argv array element
        // String CONCATENATION is an emission too: `'--model ' + m` carries the
        // same glob hazard as a template literal and would otherwise slip past
        // a scan that only looks for `${`.
        if (/--model[^'"]*['"]\s*\+/.test(line) || /--model\s*['"]\s*\+/.test(line)) {
          offenders.push(`${path.relative(MAIN_DIR, file)}:${i + 1}  ${trimmed}`)
          return
        }
        if (!line.includes('${')) return                      // no interpolation at all
        // Interpolating sites must quote. Two forms are allowed:
        //   modelFlag()'s own `--model ${quoteArgForShell(...)}`  (POSIX/PowerShell)
        //   the cmd.exe Windows-remote branch `--model "${...}"`  (claude.cmd strips ")
        const quotedHelper = /--model\s*\$\{\s*quoteArgForShell\(/.test(line)
        const cmdExeDoubleQuoted = /--model\s*"\$\{[^}]*\}"/.test(line)
        if (!quotedHelper && !cmdExeDoubleQuoted) {
          offenders.push(`${path.relative(MAIN_DIR, file)}:${i + 1}  ${trimmed}`)
        }
      })
    }
    expect(
      offenders,
      'an unquoted --model interpolation: a bracketed 1M id would be glob-expanded ' +
      'by the shell (#144). Route it through modelFlag()/quoteArgForShell().',
    ).toEqual([])
  })

  it('the cmd.exe Windows-remote branch is still double-quoted', () => {
    const src = fs.readFileSync(path.join(MAIN_DIR, 'pty-manager.ts'), 'utf-8')
    expect(/--model\s*"\$\{winModelId\}"/.test(src)).toBe(true)
  })
})
