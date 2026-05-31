import { describe, it, expect } from 'vitest'
import { withProfileConfigDir } from '../../src/main/pty-manager'

describe('withProfileConfigDir', () => {
  it('adds CLAUDE_CONFIG_DIR when a config dir is given', () => {
    const env = withProfileConfigDir({ PATH: '/x' }, 'C:/r/account-profiles/p1')
    expect(env.CLAUDE_CONFIG_DIR).toBe('C:/r/account-profiles/p1')
    expect(env.PATH).toBe('/x')
  })
  it('returns the env unchanged when no config dir', () => {
    const base = { PATH: '/x' }
    expect(withProfileConfigDir(base, null)).toBe(base)
  })
})
