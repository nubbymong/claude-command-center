import { describe, it, expect } from 'vitest'
import {
  defaultLoginShell, localSessionShell, isShFamilyShell, shFamilyLoginShell,
  LOGIN_SHELL_PATH_COMMAND, extractLoginShellPath, loginShellWithOwnPath, findOnPosixPath, findOnPosixPathAsync,
} from '../../../src/main/login-shell'

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

// PR-level ADR-009 round 1 (A1): the shell a local session's PTY runs, and
// whether it is of the sh family (Alt+V types a path only into one off Windows).
describe('localSessionShell and isShFamilyShell', () => {
  it('a local session runs PowerShell on Windows and the login shell elsewhere', () => {
    // On Windows by its full path in the system folder (windows-programs.ts systemTool).
    expect(localSessionShell({ SHELL: '/usr/bin/fish', SystemRoot: 'C:\\Windows' }, 'win32', none)).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(isShFamilyShell(localSessionShell({ SystemRoot: 'C:\\Windows' }, 'win32', none))).toBe(false)
    expect(localSessionShell({ SHELL: '/usr/bin/fish' }, 'linux', none)).toBe('/usr/bin/fish')
    expect(localSessionShell({}, 'darwin', none)).toBe('/bin/zsh')
    expect(localSessionShell({}, 'linux', has('/bin/bash'))).toBe('/bin/bash')
  })

  it('the sh family by basename: sh, bash, zsh, dash, ksh, and no other', () => {
    for (const s of ['/bin/sh', '/bin/bash', '/usr/local/bin/zsh', '/bin/dash', '/bin/ksh', 'bash']) expect(isShFamilyShell(s), s).toBe(true)
    for (const s of ['/usr/bin/fish', '/usr/bin/nu', '/usr/bin/elvish', '/usr/bin/pwsh', '/usr/bin/tcsh', '/bin/csh', '/usr/bin/xonsh', '/bin/bash5', '/bin/mksh', 'powershell.exe', '', '/bin/']) expect(isShFamilyShell(s), s).toBe(false)
  })
})

// A Claude session's launch line is written for the sh family, so the shell
// its launcher runs is always one: the login shell when it is of the family,
// else the same fallback with $SHELL set aside. A terminal tab is unaffected.
describe('a launch line is typed only into a sh-family shell', () => {
  it('keeps $SHELL when it is of the sh family', () => {
    for (const s of ['/bin/bash', '/usr/local/bin/zsh', '/bin/sh', '/bin/dash', '/bin/ksh']) {
      expect(shFamilyLoginShell({ SHELL: s }, 'linux', none), s).toBe(s)
      expect(shFamilyLoginShell({ SHELL: s }, 'darwin', none), s).toBe(s)
    }
  })

  it('sets aside a non-sh $SHELL (fish, pwsh, nu, tcsh, csh, elvish, xonsh) for the fallback', () => {
    for (const s of ['/opt/homebrew/bin/fish', '/usr/local/bin/pwsh', '/usr/bin/nu', '/bin/tcsh', '/bin/csh', '/usr/bin/elvish', '/usr/bin/xonsh']) {
      expect(shFamilyLoginShell({ SHELL: s }, 'darwin', none), s).toBe('/bin/zsh')
      expect(shFamilyLoginShell({ SHELL: s }, 'linux', has('/bin/bash', '/bin/zsh')), s).toBe('/bin/bash')
      expect(shFamilyLoginShell({ SHELL: s }, 'linux', has('/bin/zsh')), s).toBe('/bin/zsh')
      expect(shFamilyLoginShell({ SHELL: s }, 'linux', none), s).toBe('/bin/sh')
      expect(isShFamilyShell(shFamilyLoginShell({ SHELL: s }, 'freebsd', none)), s).toBe(true)
    }
  })

  it('without $SHELL it is the login shell fallback; a terminal tab still gets the user\'s own shell', () => {
    expect(shFamilyLoginShell({}, 'darwin', none)).toBe('/bin/zsh')
    expect(shFamilyLoginShell({}, 'linux', has('/bin/bash'))).toBe('/bin/bash')
    expect(localSessionShell({ SHELL: '/usr/bin/fish' }, 'linux', none)).toBe('/usr/bin/fish')
  })
})

describe('the PATH a login shell outside the sh family builds', () => {
  it('is asked through /bin/sh by its full path in one single-quoted word, which every shell family passes on as written', () => {
    expect(LOGIN_SHELL_PATH_COMMAND).toBe(`/bin/sh -c 'printf "%s%s%s" __CCC_LOGIN_PATH_BEGIN__ "$PATH" __CCC_LOGIN_PATH_END__'`)
  })

  it('is read between the last opening marker and the next closing one, absolute entries only', () => {
    expect(extractLoginShellPath('hello\n__CCC_LOGIN_PATH_BEGIN__/a:rel:/b__CCC_LOGIN_PATH_END__bye')).toBe('/a:/b')
    expect(extractLoginShellPath('__CCC_LOGIN_PATH_BEGIN__/x__CCC_LOGIN_PATH_END__ __CCC_LOGIN_PATH_BEGIN__/y__CCC_LOGIN_PATH_END__')).toBe('/y')
    expect(extractLoginShellPath('no markers')).toBeNull()
    expect(extractLoginShellPath('__CCC_LOGIN_PATH_BEGIN__/a\n/b__CCC_LOGIN_PATH_END__')).toBeNull()
    expect(extractLoginShellPath('__CCC_LOGIN_PATH_BEGIN__rel:.:__CCC_LOGIN_PATH_END__')).toBeNull()
    expect(extractLoginShellPath('__CCC_LOGIN_PATH_BEGIN__/a')).toBeNull()
  })

  it('is asked only of a login shell outside the sh family, and never on Windows', () => {
    expect(loginShellWithOwnPath({ SHELL: '/opt/homebrew/bin/fish' }, 'darwin')).toBe('/opt/homebrew/bin/fish')
    expect(loginShellWithOwnPath({ SHELL: '/usr/bin/pwsh' }, 'linux')).toBe('/usr/bin/pwsh')
    for (const s of ['/bin/bash', '/bin/zsh', '/bin/sh', '/usr/bin/dash', '/bin/ksh']) expect(loginShellWithOwnPath({ SHELL: s }, 'linux'), s).toBeNull()
    expect(loginShellWithOwnPath({}, 'darwin', none)).toBeNull()
    expect(loginShellWithOwnPath({ SHELL: '/opt/homebrew/bin/fish' }, 'win32')).toBeNull()
  })
})

describe('a program found in a POSIX PATH without a shell', () => {
  it('the first absolute folder holding it as a file someone may run, in PATH order; never a relative entry or a name with a separator', async () => {
    const runnable = (p: string) => ['rel/claude', '/b/claude', '/c/claude'].includes(p)
    expect(findOnPosixPath('claude', 'rel:/a:/b:/c', runnable)).toBe('/b/claude')
    expect(await findOnPosixPathAsync('claude', 'rel:/a:/b:/c', async (p) => runnable(p))).toBe('/b/claude')
    expect(findOnPosixPath('claude', 'rel:/a', runnable)).toBeNull()
    expect(findOnPosixPath('../claude', '/b', () => true)).toBeNull()
    expect(findOnPosixPath('', '/b', () => true)).toBeNull()
  })
})
