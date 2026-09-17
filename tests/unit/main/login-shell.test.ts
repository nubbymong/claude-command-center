import { describe, it, expect } from 'vitest'
import { defaultLoginShell } from '../../../src/main/login-shell'

// The three CLI probes (cli:check, the setup probe, the setup PTY) used to fall
// back to /bin/zsh on every non-Windows platform. On a Linux box without zsh
// and without $SHELL that is an ENOENT, reported as "Claude CLI not found"
// (final adversarial pass, 2.1.1).
const has = (...paths: string[]) => (p: string) => paths.includes(p)
const none = () => false

describe('defaultLoginShell', () => {
  it('honours $SHELL on every platform, without touching the filesystem', () => {
    const boom = () => { throw new Error('must not stat when $SHELL is set') }
    expect(defaultLoginShell({ SHELL: '/usr/local/bin/fish' }, 'linux', boom)).toBe('/usr/local/bin/fish')
    expect(defaultLoginShell({ SHELL: '/bin/bash' }, 'darwin', boom)).toBe('/bin/bash')
  })

  it('macOS without $SHELL is zsh, the platform default shell', () => {
    expect(defaultLoginShell({}, 'darwin', none)).toBe('/bin/zsh')
    expect(defaultLoginShell({ SHELL: '' }, 'darwin', none)).toBe('/bin/zsh')
  })

  it('Linux without $SHELL prefers bash (what the spawn paths fall back to), else /bin/sh', () => {
    expect(defaultLoginShell({}, 'linux', has('/bin/bash', '/bin/sh'))).toBe('/bin/bash')
    expect(defaultLoginShell({ SHELL: '' }, 'linux', has('/bin/bash'))).toBe('/bin/bash')
    expect(defaultLoginShell({}, 'linux', has('/bin/sh'))).toBe('/bin/sh')
    expect(defaultLoginShell({}, 'linux', none)).toBe('/bin/sh')
    expect(defaultLoginShell({}, 'freebsd', none)).toBe('/bin/sh')
  })

  it('never answers zsh off macOS', () => {
    expect(defaultLoginShell({}, 'linux', has('/bin/zsh', '/bin/bash', '/bin/sh'))).not.toBe('/bin/zsh')
    expect(defaultLoginShell({}, 'linux', has('/bin/zsh'))).toBe('/bin/sh')
  })

  it('the defaults read the real process (env, platform) and the real filesystem', () => {
    // Not a re-derivation of the rule: it pins that a zero-argument call is
    // wired to process.env / process.platform / fs, which is what the three
    // call sites rely on.
    const r = defaultLoginShell()
    if (process.env.SHELL) expect(r).toBe(process.env.SHELL)
    else if (process.platform === 'darwin') expect(r).toBe('/bin/zsh')
    else expect(['/bin/bash', '/bin/sh']).toContain(r)
  })
})
