// One rule for text shown from outside the app, in three places: the shared
// module, and the two picker scripts the app ships that cannot import it (they
// run as plain Node scripts in the session's terminal). Each copy is read from
// its source as text, compiled, and asked about the same code points; all
// three must give the same answer for every one. A copy that drifts, or that
// one change forgets, fails here rather than on a user's screen.
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')

/** The three copies: file, and the name of the constant that holds the rule. */
const COPIES = [
  { file: 'src/shared/safe-text.ts', name: 'SPOOFABLE' },
  { file: 'scripts/resume-picker.js', name: 'SPOOFABLE' },
  { file: 'scripts/lib/codex-resume-picker-lib.js', name: 'NOT_PLAIN_TEXT' },
] as const

function ruleOf(file: string, name: string): RegExp {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const decl = new RegExp(String.raw`^\s*const ${name} = /(.+)/([a-z]*)\s*$`, 'gm')
  const found = [...text.matchAll(decl)]
  if (found.length !== 1) throw new Error(`${file}: expected one "const ${name} = /.../" line, found ${found.length}`)
  const [, body, flags] = found[0]
  return new RegExp(body, flags)
}

/** Every code point of the planes text actually uses (BMP, including each
 *  surrogate on its own; the supplementary plane; the special-purpose
 *  plane), and a stride through the rest. */
function codePoints(): number[] {
  const out: number[] = []
  for (let n = 0; n <= 0x1ffff; n++) out.push(n)
  for (let n = 0xe0000; n <= 0xeffff; n++) out.push(n)
  for (let n = 0x20000; n <= 0x10ffff; n += 97) out.push(n)
  return out
}

const drops = (re: RegExp, s: string): boolean => {
  re.lastIndex = 0
  return re.test(s)
}

describe('shown text: the three copies of the rule agree', () => {
  const rules = COPIES.map((c) => ({ ...c, re: ruleOf(c.file, c.name) }))

  it('every copy matches globally and by code point', () => {
    for (const r of rules) {
      expect(r.re.flags, r.file).toContain('g')
      expect(r.re.flags, r.file).toContain('u')
    }
  })

  it('every copy drops exactly the same code points (every copy that drifts is named)', () => {
    const [first, ...rest] = rules
    const drifted: string[] = []
    for (const other of rest) {
      const differ: string[] = []
      for (const n of codePoints()) {
        const s = String.fromCodePoint(n)
        if (drops(first.re, s) !== drops(other.re, s)) differ.push(`U+${n.toString(16).toUpperCase().padStart(4, '0')}`)
      }
      if (differ.length > 0) drifted.push(`${other.file} against ${first.file}: ${differ.length} code points differ, first ${differ.slice(0, 8).join(' ')}`)
    }
    expect(drifted).toEqual([])
  })

  it('every copy keeps a whole surrogate pair and drops a lone half', () => {
    for (const r of rules) {
      expect(drops(r.re, '😀'), r.file).toBe(false)
      expect(drops(r.re, '\ud83d'), r.file).toBe(true)
      expect(drops(r.re, '\ude00'), r.file).toBe(true)
    }
  })
})
