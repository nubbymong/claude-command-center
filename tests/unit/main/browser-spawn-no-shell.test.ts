// Adversarial pass on #598 (SSO browser picker, aicc_planning#43): the browser
// binary is handed to spawn() as argv[0] with NO shell, at both launch sites, so
// a path with spaces or metacharacters -- a per-user %LOCALAPPDATA% install --
// is never re-parsed by cmd.exe. Neither site can be executed under vitest
// without a real browser, so the SHAPE of every spawn() call is pinned.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (rel: string) => readFileSync(resolve(__dirname, '../../../src/main', rel), 'utf8').replace(/\r\n/g, '\n')

/** Every `spawn(` call expression in `src`, from the call to its closing paren. */
function spawnCalls(src: string): string[] {
  const out: string[] = []
  const re = /\bspawn\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let depth = 0
    let i = m.index + m[0].length - 1
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') { depth--; if (depth === 0) break }
    }
    out.push(src.slice(m.index, i + 1))
  }
  return out
}

describe('the browser binary is spawned as argv[0], never through a shell', () => {
  it('account-web/sign-in.ts', () => {
    const calls = spawnCalls(read('account-web/sign-in.ts'))
    expect(calls.some((c) => c.startsWith('spawn(bin.path, args,'))).toBe(true)
    for (const c of calls) expect(c, c).not.toMatch(/\bshell\s*:/)
  })

  it('vision-manager.ts', () => {
    const calls = spawnCalls(read('vision-manager.ts'))
    expect(calls.some((c) => c.startsWith('spawn(executable, args,'))).toBe(true)
    for (const c of calls) expect(c, c).not.toMatch(/\bshell\s*:/)
  })
})
