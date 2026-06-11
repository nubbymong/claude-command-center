import { describe, it, expect } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { withProfileHome } from '../../src/main/pty-manager'

// Platform-native fake home. A hardcoded Windows drive path breaks on POSIX
// CI: its `:` collides with the POSIX PATH delimiter, so the PATH-dedup split
// can never match it (prod never sees that mix — homes are platform-native).
const HOME = path.resolve('/r/account-profiles/p1')
const LOCAL_BIN = path.join(HOME, '.local', 'bin')

describe('withProfileHome', () => {
  it('sets USERPROFILE to the fake home and points git/npm at the real home', () => {
    const env = withProfileHome({ PATH: '/x' }, HOME)
    expect(env.USERPROFILE).toBe(HOME)
    // git/npm belt-and-suspenders -> real home
    expect(env.GIT_CONFIG_GLOBAL).toBe(path.join(os.homedir(), '.gitconfig'))
    expect(env.npm_config_userconfig).toBe(path.join(os.homedir(), '.npmrc'))
    // It must NOT set the old CLAUDE_CONFIG_DIR lever (that never isolated identity).
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  it('appends the redirected ~/.local/bin to PATH so CC /doctor install check passes', () => {
    const env = withProfileHome({ PATH: '/x' }, HOME)
    expect(env.PATH).toBe(`/x${path.delimiter}${LOCAL_BIN}`)
  })

  it('does not duplicate the bin dir when PATH already contains it', () => {
    const env = withProfileHome({ PATH: `/x${path.delimiter}${LOCAL_BIN}` }, HOME)
    expect(env.PATH).toBe(`/x${path.delimiter}${LOCAL_BIN}`)
  })

  it('updates the existing path key regardless of case (Path vs PATH)', () => {
    const env = withProfileHome({ Path: '/x' }, HOME)
    expect(env.Path).toBe(`/x${path.delimiter}${LOCAL_BIN}`)
    // no stray uppercase PATH key was created
    expect(env.PATH).toBeUndefined()
  })

  it('returns the env unchanged for the Default account (home null)', () => {
    const base = { PATH: '/x' }
    expect(withProfileHome(base, null)).toBe(base)
  })
})
