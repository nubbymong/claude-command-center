// The program name a Conductor terminal's shell is given at the start of a
// line the app types or shows. PURE.
//
// In PowerShell a plain `npm` runs npm.ps1, which the default script policy
// on a Windows client refuses to load ("running scripts is disabled on this
// system"); npm.cmd, the batch shim beside it, is not subject to that policy.
import { describe, it, expect } from 'vitest'
import { shellProgram } from '../../../src/shared/shell-program'

describe('shellProgram', () => {
  it('on Windows npm is npm.cmd', () => {
    expect(shellProgram('npm', 'win32')).toBe('npm.cmd')
  })

  it('on macOS, Linux, or a platform not known, npm stays npm', () => {
    for (const p of ['darwin', 'linux', undefined]) expect(shellProgram('npm', p), String(p)).toBe('npm')
  })

  it('any other program keeps its name on every platform', () => {
    for (const p of ['win32', 'darwin', 'linux', undefined]) {
      for (const program of ['brew', 'git', 'claude', 'npm.cmd']) expect(shellProgram(program, p), `${p} ${program}`).toBe(program)
    }
  })
})
