import { describe, it, expect } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { withProfileHome } from '../../src/main/pty-manager'

describe('withProfileHome', () => {
  it('sets USERPROFILE to the fake home and points git/npm at the real home', () => {
    const env = withProfileHome({ PATH: '/x' }, 'C:/r/account-profiles/p1')
    expect(env.USERPROFILE).toBe('C:/r/account-profiles/p1')
    expect(env.PATH).toBe('/x')
    // git/npm belt-and-suspenders -> real home
    expect(env.GIT_CONFIG_GLOBAL).toBe(path.join(os.homedir(), '.gitconfig'))
    expect(env.npm_config_userconfig).toBe(path.join(os.homedir(), '.npmrc'))
    // It must NOT set the old CLAUDE_CONFIG_DIR lever (that never isolated identity).
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })
  it('returns the env unchanged for the Default account (home null)', () => {
    const base = { PATH: '/x' }
    expect(withProfileHome(base, null)).toBe(base)
  })
})
