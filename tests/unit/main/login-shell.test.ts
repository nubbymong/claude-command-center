import { describe, it, expect } from 'vitest'
import { defaultLoginShell } from '../../../src/main/login-shell'

// The three CLI probes (cli:check, the setup probe, the setup PTY) used to fall
// back to /bin/zsh on every non-Windows platform. On a Linux box without zsh
// and without $SHELL that is an ENOENT, reported as "Claude CLI not found"
// (final adversarial pass, 2.1.1).
describe('defaultLoginShell', () => {
  it('honours $SHELL on every platform', () => {
    expect(defaultLoginShell({ SHELL: '/usr/local/bin/fish' }, 'linux')).toBe('/usr/local/bin/fish')
    expect(defaultLoginShell({ SHELL: '/bin/bash' }, 'darwin')).toBe('/bin/bash')
  })

  it('macOS without $SHELL is zsh, the platform default shell', () => {
    expect(defaultLoginShell({}, 'darwin')).toBe('/bin/zsh')
    expect(defaultLoginShell({ SHELL: '' }, 'darwin')).toBe('/bin/zsh')
  })

  it('Linux (and any other non-mac platform) without $SHELL is /bin/sh, which always exists', () => {
    expect(defaultLoginShell({}, 'linux')).toBe('/bin/sh')
    expect(defaultLoginShell({ SHELL: '' }, 'linux')).toBe('/bin/sh')
    expect(defaultLoginShell({}, 'freebsd')).toBe('/bin/sh')
  })

  it('reads the real process by default', () => {
    const expected = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
    expect(defaultLoginShell()).toBe(expected)
  })
})
