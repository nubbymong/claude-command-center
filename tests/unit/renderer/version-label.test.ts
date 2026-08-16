import { describe, it, expect } from 'vitest'
import {
  formatInstalledVersion,
  releaseLine,
  isPrereleaseVersion,
  defaultUpdateChannelForVersion,
} from '../../../src/renderer/utils/versionLabel'

describe('formatInstalledVersion', () => {
  it('renders the full version tag + beta channel', () => {
    expect(formatInstalledVersion('2.1.0-beta.8', 'beta')).toBe('v2.1.0-beta.8 (beta)')
  })

  it('renders the full version tag + stable channel', () => {
    expect(formatInstalledVersion('2.0.0', 'stable')).toBe('v2.0.0 (stable)')
  })

  it('preserves rc-style prerelease suffixes verbatim', () => {
    expect(formatInstalledVersion('2.2.0-rc.1', 'beta')).toBe('v2.2.0-rc.1 (beta)')
  })
})

describe('releaseLine', () => {
  it('reduces a full tag to its release line', () => {
    expect(releaseLine('2.1.0-beta.10')).toBe('2.1')
    expect(releaseLine('2.0.0')).toBe('2.0')
  })

  it('falls back to the input when it does not parse', () => {
    expect(releaseLine('')).toBe('')
    expect(releaseLine('nonsense')).toBe('nonsense')
  })
})

describe('isPrereleaseVersion', () => {
  it('is true for beta and rc builds', () => {
    expect(isPrereleaseVersion('2.1.0-beta.10')).toBe(true)
    expect(isPrereleaseVersion('2.2.0-rc.1')).toBe(true)
    expect(isPrereleaseVersion('2.2.0-p3.1')).toBe(true)
    expect(isPrereleaseVersion('v2.1.0-beta.1')).toBe(true)
    expect(isPrereleaseVersion('  2.1.0-beta.1  ')).toBe(true)
  })

  it('is false for a final release', () => {
    expect(isPrereleaseVersion('2.0.0')).toBe(false)
    expect(isPrereleaseVersion('2.1.0')).toBe(false)
    expect(isPrereleaseVersion('v2.1.0')).toBe(false)
  })

  it('is false for anything that does not parse (absent define, dev build)', () => {
    expect(isPrereleaseVersion('')).toBe(false)
    expect(isPrereleaseVersion('nonsense')).toBe(false)
    expect(isPrereleaseVersion(undefined as unknown as string)).toBe(false)
  })
})

describe('defaultUpdateChannelForVersion', () => {
  it('puts a prerelease build on the beta channel', () => {
    expect(defaultUpdateChannelForVersion('2.1.0-beta.10')).toBe('beta')
    expect(defaultUpdateChannelForVersion('2.2.0-rc.1')).toBe('beta')
  })

  it('leaves a final release on stable', () => {
    expect(defaultUpdateChannelForVersion('2.1.0')).toBe('stable')
  })

  it('degrades to stable when the version is unusable', () => {
    expect(defaultUpdateChannelForVersion('')).toBe('stable')
  })
})
