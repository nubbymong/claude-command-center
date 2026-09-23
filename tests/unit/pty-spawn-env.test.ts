import { describe, it, expect, beforeAll } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { withProfileHome } from '../../src/main/pty-manager'
import { composeProviders } from '../../src/main/providers/compose'

// withProfileHome takes the Claude package's OWN policy -- the ambient
// authority list and the host control -- from the registry, so a launch path
// cannot compose a managed environment that opts out of either. In the app,
// boot composes before anything spawns; a test that exercises the launch path
// has to do the same. Deliberately NOT done in the global setup: the
// registry's own suite asserts what an EMPTY registry does.
beforeAll(() => { composeProviders() })

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

  // #117: macOS resolves the login keychain via $HOME. Redirecting HOME to the fake
  // profile home (no ~/Library/Keychains) breaks keychain access ("A keychain cannot
  // be found to store ..."). HOME must be redirected ONLY on Linux (Secret Service /
  // D-Bus keychains are not HOME-path-based); never on macOS or Windows.
  it('redirects HOME only on Linux, not macOS/Windows (#117)', () => {
    const env = withProfileHome({ PATH: '/x' }, HOME)
    if (process.platform === 'linux') {
      expect(env.HOME).toBe(HOME)
    } else {
      expect(env.HOME).toBeUndefined()
    }
  })
})
