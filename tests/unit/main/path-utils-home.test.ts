import { describe, it, expect } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import { isHomeOrAncestor } from '../../../src/main/path-utils'

/**
 * SECURITY (adversarial review, #188): isHomeOrAncestor is the guard that keeps
 * codex_review off the home directory and its ancestors — a `===` string compare
 * was bypassable on Windows by a case-variant or junction form of home.
 */
describe('isHomeOrAncestor', () => {
  const home = os.homedir()

  it('is true for the exact home directory', () => {
    expect(isHomeOrAncestor(home)).toBe(true)
  })

  it('is true for an ancestor of home (parent dir)', () => {
    const parent = path.dirname(home)
    // Only assert when home genuinely has a parent (not a drive root).
    if (parent !== home) expect(isHomeOrAncestor(parent)).toBe(true)
  })

  it('is false for a subdirectory of home (a real project dir)', () => {
    expect(isHomeOrAncestor(path.join(home, 'some-project'))).toBe(false)
  })

  it('is false for an unrelated temp directory', () => {
    const tmp = os.tmpdir()
    // tmp is only a valid negative if it isn't itself an ancestor of home.
    if (!home.toLowerCase().startsWith(tmp.toLowerCase())) {
      expect(isHomeOrAncestor(tmp)).toBe(false)
    }
  })

  it('catches a case-variant of home on case-insensitive platforms (Windows)', () => {
    if (process.platform !== 'win32') return
    const variant = home.toLowerCase()
    if (variant !== home) expect(isHomeOrAncestor(variant)).toBe(true)
  })

  it('catches the trailing-separator form of home', () => {
    expect(isHomeOrAncestor(home + path.sep)).toBe(true)
  })
})
