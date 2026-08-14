/**
 * The two launch-line values in pty-manager that are NOT built by
 * spawn-claude-command, and therefore did not inherit its quoting fix.
 *
 * Both were confirmed executing arbitrary PowerShell during an independent
 * review, from the same config JSON as the originally-reported working
 * directory:
 *
 *   - the shell-only ("Terminal" session) `Set-Location` — the twin of the
 *     Claude launch path, firing on the cd before any binary runs;
 *   - the `--agents` JSON, where a curly apostrophe in an agent description is
 *     ordinary prose and broke launches by accident.
 *
 * pty-manager itself cannot be imported in a unit test (node-pty + Electron),
 * so these assert the PROPERTY of the shared helper against the exact values
 * those sites now pass through it. The guard that matters is that neither site
 * hand-rolls its own escaping again — asserted by source inspection below.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { quoteArgForShell } from '../../../src/main/spawn-claude-command'

const PS_QUOTE_CHARS = ['\u0027', '\u2018', '\u2019', '\u201A', '\u201B']
const PAYLOAD = 'Write-Output PWNED'

/** Everything not inside a quoted run — see spawn-shell-quote-injection. */
function outsideQuotes(command: string): string {
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote === null) {
      if (PS_QUOTE_CHARS.includes(c)) {
        quote = c
        continue
      }
      out += c
      continue
    }
    if (!PS_QUOTE_CHARS.includes(c)) continue
    if (command[i + 1] === c) {
      i++
      continue
    }
    quote = null
  }
  return out
}

describe('shell-only session: the Set-Location line', () => {
  for (const q of PS_QUOTE_CHARS) {
    it(`U+${q.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')} in the working directory cannot escape`, () => {
      const cwd = `C:\\proj${q}; ${PAYLOAD}; ${q}\\end`
      const cdCmd = `Set-Location -LiteralPath ${quoteArgForShell(cwd, true)}`
      expect(outsideQuotes(cdCmd)).not.toContain('PWNED')
      expect(outsideQuotes(cdCmd).trim()).toBe('Set-Location -LiteralPath')
    })
  }

  it('uses -LiteralPath, so a real directory with wildcard characters is found', () => {
    // Set-Location treats its argument as a WILDCARD by default: a genuine
    // folder named `proj[1m]` matches nothing and the session silently starts
    // in the wrong directory (the #144 bracket class, one layer down).
    const cdCmd = `Set-Location -LiteralPath ${quoteArgForShell('C:\\proj[1m]', true)}`
    expect(cdCmd).toContain('-LiteralPath')
    expect(cdCmd).toContain("'C:\\proj[1m]'")
  })

  it('posix keeps close-escape-reopen', () => {
    expect(quoteArgForShell("/home/o'brien", false)).toBe("'/home/o'\\''brien'")
  })
})

describe('--agents JSON', () => {
  const agentsJson = (name: string) => JSON.stringify([{ name, description: 'd', prompt: 'p' }])

  for (const q of PS_QUOTE_CHARS) {
    it(`U+${q.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')} in an agent name cannot escape`, () => {
      const flag = ` --agents ${quoteArgForShell(agentsJson(`evil${q}; ${PAYLOAD}; ${q}x`), true)}`
      expect(outsideQuotes(flag)).not.toContain('PWNED')
    })
  }

  it('a plain apostrophe in prose still round-trips (the accidental-breakage case)', () => {
    const flag = ` --agents ${quoteArgForShell(agentsJson("O'Brien's reviewer"), true)}`
    expect(flag).toContain("O''Brien''s reviewer")
    expect(outsideQuotes(flag)).not.toContain('Brien')
  })
})

describe('neither call site hand-rolls its escaping any more', () => {
  // The regression that matters is structural: both sites previously carried
  // their own `replace(/'/g, "''")`, which is exactly how they kept the old
  // behaviour when the shared helper was fixed.
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'src', 'main', 'pty-manager.ts'),
    'utf8',
  )

  it('the shell-only cd goes through quoteArgForShell', () => {
    expect(src).toMatch(/Set-Location -LiteralPath \$\{quoteArgForShell\(resolvedCwd, true\)\}/)
    expect(src).not.toMatch(/escapedShellCwd/)
  })

  it('the agents flag goes through quoteArgForShell', () => {
    expect(src).toMatch(/--agents \$\{quoteArgForShell\(agentsJson,/)
  })

  it('no win32 ASCII-only doubling survives anywhere in the launch path', () => {
    // `replace(/'/g, "''")` is the win32 form; the posix `'\''` form is correct
    // and stays. Any reappearance of the win32 form here is the bug returning.
    const winDoubling = /replace\(\/'\/g,\s*["']''["']\)/g
    expect(src.match(winDoubling)).toBeNull()
  })
})
