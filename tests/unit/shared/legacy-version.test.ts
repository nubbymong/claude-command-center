import { describe, it, expect } from 'vitest'
import { isValidLegacyVersion } from '../../../src/shared/legacy-version'

describe('isValidLegacyVersion', () => {
  it('accepts plain semver versions', () => {
    expect(isValidLegacyVersion('1.2.3')).toBe(true)
    expect(isValidLegacyVersion('0.0.1')).toBe(true)
    expect(isValidLegacyVersion('2.1.177')).toBe(true)
    expect(isValidLegacyVersion('10.20.30')).toBe(true)
  })

  it('accepts semver prerelease versions (the real beta channel)', () => {
    expect(isValidLegacyVersion('1.0.0-beta.13')).toBe(true)
    expect(isValidLegacyVersion('1.2.0-beta.13')).toBe(true)
    expect(isValidLegacyVersion('1.0.0-alpha')).toBe(true)
    expect(isValidLegacyVersion('1.0.0-rc.1')).toBe(true)
  })

  it('accepts semver build metadata (charset-safe)', () => {
    expect(isValidLegacyVersion('1.0.0+build.1')).toBe(true)
  })

  it('rejects path-traversal sequences', () => {
    expect(isValidLegacyVersion('..')).toBe(false)
    expect(isValidLegacyVersion('../foo')).toBe(false)
    expect(isValidLegacyVersion('..\\foo')).toBe(false)
    expect(isValidLegacyVersion('../../../etc/passwd')).toBe(false)
    expect(isValidLegacyVersion('..\\..\\..\\Windows\\System32')).toBe(false)
    expect(isValidLegacyVersion('1.2.3/../../evil')).toBe(false)
    expect(isValidLegacyVersion('1.2.3\\..\\evil')).toBe(false)
  })

  it('rejects absolute paths', () => {
    expect(isValidLegacyVersion('/etc/passwd')).toBe(false)
    expect(isValidLegacyVersion('C:\\Windows')).toBe(false)
    expect(isValidLegacyVersion('\\\\server\\share')).toBe(false)
  })

  it('rejects shell metacharacters (npm-arg / shell-interpolation injection)', () => {
    expect(isValidLegacyVersion('1.2.3; rm -rf /')).toBe(false)
    expect(isValidLegacyVersion('1.2.3 && calc')).toBe(false)
    expect(isValidLegacyVersion('1.2.3 | evil')).toBe(false)
    expect(isValidLegacyVersion('1.2.3`whoami`')).toBe(false)
    expect(isValidLegacyVersion('1.2.3$(whoami)')).toBe(false)
    expect(isValidLegacyVersion('$(rm -rf ~)')).toBe(false)
  })

  it('rejects leading-dash npm flag injection', () => {
    expect(isValidLegacyVersion('-1.2.3')).toBe(false)
    expect(isValidLegacyVersion('--global')).toBe(false)
    expect(isValidLegacyVersion('--prefix=/tmp')).toBe(false)
  })

  it('rejects embedded newlines (regex anchor bypass guard)', () => {
    expect(isValidLegacyVersion('1.2.3\n')).toBe(false)
    expect(isValidLegacyVersion('1.2.3\nevil')).toBe(false)
    expect(isValidLegacyVersion('evil\n1.2.3')).toBe(false)
  })

  it('rejects non-semver and malformed input', () => {
    expect(isValidLegacyVersion('')).toBe(false)
    expect(isValidLegacyVersion('latest')).toBe(false)
    expect(isValidLegacyVersion('foo')).toBe(false)
    expect(isValidLegacyVersion('1')).toBe(false)
    expect(isValidLegacyVersion('1.2')).toBe(false)
    expect(isValidLegacyVersion('1.2.3.4')).toBe(false)
    expect(isValidLegacyVersion('v1.2.3')).toBe(false) // npm coordinate has no leading v
    expect(isValidLegacyVersion('1.2.x')).toBe(false)
    expect(isValidLegacyVersion('^1.2.3')).toBe(false) // range, not a concrete version
    expect(isValidLegacyVersion('1.2.3 ')).toBe(false) // trailing space
    expect(isValidLegacyVersion(' 1.2.3')).toBe(false) // leading space
  })

  it('rejects non-string input', () => {
    expect(isValidLegacyVersion(undefined)).toBe(false)
    expect(isValidLegacyVersion(null)).toBe(false)
    expect(isValidLegacyVersion(123)).toBe(false)
    expect(isValidLegacyVersion({})).toBe(false)
  })

  it('rejects pathologically long input (defensive length cap)', () => {
    expect(isValidLegacyVersion('1.2.' + '3'.repeat(200))).toBe(false)
  })
})
