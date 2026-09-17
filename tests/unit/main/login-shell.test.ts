import { describe, it, expect } from 'vitest'
import { defaultLoginShell } from '../../../src/main/login-shell'

// The three CLI probes (cli:check, the setup probe, the setup PTY) used to fall
// back to /bin/zsh on every non-Windows platform and the local session launch
// to /bin/bash. On a Linux box without zsh and without $SHELL the probe was an
// ENOENT reported as "Claude CLI not found"; without bash the launch was the
// ENOENT instead (final adversarial pass, 2.1.1). One rule for all of them.
const has = (...paths: string[]) => (p: string) => paths.includes(p)
const none = () => false

describe('defaultLoginShell', () => {
  it('honours $SHELL on every platform, without touching the filesystem', () => {
    const boom = () => { throw new Error('must not stat when $SHELL is set') }
    expect(defaultLoginShell({ SHELL: '/usr/local/bin/fish' }, 'linux', boom)).toBe('/usr/local/bin/fish')
    expect(defaultLoginShell({ SHELL: '/bin/bash' }, 'darwin', boom)).toBe('/bin/bash')
  })

  it('macOS without $SHELL is zsh, the platform default shell, without a stat', () => {
    const boom = () => { throw new Error('darwin needs no stat') }
    expect(defaultLoginShell({}, 'darwin', boom)).toBe('/bin/zsh')
    expect(defaultLoginShell({ SHELL: '' }, 'darwin', boom)).toBe('/bin/zsh')
  })

  it('Linux without $SHELL takes the first of bash, zsh, sh that exists', () => {
    expect(defaultLoginShell({}, 'linux', has('/bin/bash', '/bin/zsh', '/bin/sh'))).toBe('/bin/bash')
    expect(defaultLoginShell({ SHELL: '' }, 'linux', has('/bin/bash'))).toBe('/bin/bash')
    // a zsh-only box keeps working (the old code ran zsh there; the first fix
    // of this pass would have dropped it to sh -- re-attack finding)
    expect(defaultLoginShell({}, 'linux', has('/bin/zsh', '/bin/sh'))).toBe('/bin/zsh')
    expect(defaultLoginShell({}, 'linux', has('/bin/sh'))).toBe('/bin/sh')
    expect(defaultLoginShell({}, 'linux', none)).toBe('/bin/sh')
    expect(defaultLoginShell({}, 'freebsd', none)).toBe('/bin/sh')
  })

  it('never assumes a shell that is not there', () => {
    // the old fallback: zsh unconditionally, present or not
    expect(defaultLoginShell({}, 'linux', has('/bin/bash', '/bin/sh'))).not.toBe('/bin/zsh')
    expect(defaultLoginShell({}, 'linux', none)).not.toBe('/bin/zsh')
    expect(defaultLoginShell({}, 'linux', none)).not.toBe('/bin/bash')
  })

  it('the defaults read the real process (env, platform) and the real filesystem', () => {
    // Not a re-derivation of the rule: it pins that a zero-argument call is
    // wired to process.env / process.platform / fs, which the call sites rely on.
    const r = defaultLoginShell()
    if (process.env.SHELL) expect(r).toBe(process.env.SHELL)
    else if (process.platform === 'darwin') expect(r).toBe('/bin/zsh')
    else expect(['/bin/bash', '/bin/zsh', '/bin/sh']).toContain(r)
  })
})
