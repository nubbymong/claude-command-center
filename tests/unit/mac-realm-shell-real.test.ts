// @vitest-environment node
//
// Re-attack r4, MAJOR 1 (ADR-024): the EXACT lines a macOS realm shell-only
// session types -- the base `cd ...; clear` line, then the `claude` pin as
// separate lines -- run through a REAL interactive bash and dash whose rc
// defines `alias claude=...`. Before the fix the one-line pin was a syntax
// error there: the aliased (unverified) binary ran and the `cd` was lost.
//
// Runs only where a real shell is available: on a POSIX host directly, on a
// Windows host through WSL. Skipped otherwise (it does not fake a shell).
// The ORDER of the writes is asserted without a shell in
// mac-realm-guard.test.ts.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { realmShellPinLines, shellOnlyOpeningLines } from '../../src/main/mac-realm-shell'
import { quoteArgForShell } from '../../src/shared/shell-quote'

const viaWsl = process.platform === 'win32'
const run = (cmd: string, args: string[], input?: string) =>
  spawnSync(viaWsl ? 'wsl' : cmd, viaWsl ? ['-e', cmd, ...args] : args, { input, encoding: 'utf8', timeout: 20_000, windowsHide: true })
const has = (shell: string): boolean => {
  try { const r = run(shell, ['-c', 'exit 0']); return r.status === 0 } catch { return false }
}
const shells = (['bash', 'dash'] as const).filter((s) => has(s))

describe.skipIf(shells.length === 0)('the realm pin in a real interactive shell with `alias claude` in its rc', () => {
  for (const shell of shells) {
    it(`${shell}: claude runs the pinned binary, in the configured directory`, () => {
      const mk = run('sh', ['-c', 'd=$(mktemp -d) && mkdir -p "$d/work dir" "$d/bin dir" && printf \'#!/bin/sh\\necho "VERIFIED $PWD"\\n\' > "$d/bin dir/claude" && chmod +x "$d/bin dir/claude" && printf "alias claude=\'echo UNVERIFIED\'\\n" > "$d/rc" && echo "$d"'])
      expect(mk.status, mk.stderr).toBe(0)
      const d = mk.stdout.trim()
      try {
        const bin = `${d}/bin dir/claude`
        const lines = shellOnlyOpeningLines(
          `cd ${quoteArgForShell(`${d}/work dir`, false)} 2>/dev/null; clear`,
          realmShellPinLines(bin, `/bin/${shell}`, ['-l']),
          null,
        )
        const input = [...lines, 'claude', 'exit'].join('\n') + '\n'
        const r = shell === 'bash'
          ? run('env', ['TERM=dumb', 'bash', '--rcfile', `${d}/rc`, '-i'], input)
          : run('env', ['TERM=dumb', `ENV=${d}/rc`, 'dash', '-i'], input)
        const out = `${r.stdout}\n${r.stderr}`
        expect(out).toContain(`VERIFIED ${d}/work dir`)
        expect(out).not.toContain('UNVERIFIED')
        expect(out).not.toMatch(/syntax error|Syntax error/)
      } finally {
        run('sh', ['-c', `rm -rf ${quoteArgForShell(d, false)}`])
      }
    })
  }
})
