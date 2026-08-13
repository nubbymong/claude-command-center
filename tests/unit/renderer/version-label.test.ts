import { describe, it, expect } from 'vitest'
import { formatInstalledVersion } from '../../../src/renderer/utils/versionLabel'

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
