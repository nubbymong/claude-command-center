// The local Claude session launch and the CLI probes must agree on the shell
// (final adversarial pass, 2.1.1): the launch hard-coded /bin/bash while the
// probes hard-coded /bin/zsh, so with $SHELL unset a box could pass the
// probe and fail every launch, or the reverse. Both now go through
// login-shell.ts. Pinned here through the REAL helper (only the platform and
// the filesystem are stubbed), so a launch that regrows its own fallback is red.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const host = vi.hoisted(() => ({ platform: 'linux' as NodeJS.Platform, present: new Set<string>() }))
vi.mock('os', async (importOriginal) => {
  const real = await importOriginal<typeof import('os')>()
  return { ...real, platform: () => host.platform }
})
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  // The stub OWNS every /bin/* answer. An OR with the real filesystem would
  // let a macOS or Linux runner's real /bin/bash answer the question under
  // test (green on Windows, red in CI -- adversarial re-attack, 2.1.1);
  // everything else (legacy-version-manager and friends) keeps the real fs.
  return { ...real, existsSync: (p: string) => (String(p).startsWith('/bin/') ? host.present.has(String(p)) : real.existsSync(p)) }
})

// A login shell outside the sh family is asked for the PATH it builds
// (claude-launch-login-path.test.ts covers its answer). Here it gives none, so
// these cases pin the launcher a session falls back to; no shell starts.
const asked = vi.hoisted(() => ({ files: [] as string[] }))
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFileSync: (file: string) => { asked.files.push(file); throw new Error('no answer in this test') },
  execFile: (file: string, _a: unknown, _o: unknown, cb?: (e: unknown) => void) => { asked.files.push(file); cb?.(new Error('no answer in this test')); return { pid: 1 } },
}))

const { buildClaudeLocalSpawn } = await import('../../../../src/main/providers/claude/spawn')
const { _resetClaudeLoginShellLookupForTest } = await import('../../../../src/main/claude-cli-probe')

const BASE_OPTS = { sessionId: 'ses-1', cwd: '/work', cols: 80, rows: 24 }
const savedShell = process.env.SHELL

beforeEach(() => {
  host.platform = 'linux'
  host.present = new Set()
  delete process.env.SHELL
  asked.files.length = 0
  _resetClaudeLoginShellLookupForTest()
})
afterEach(() => {
  if (savedShell === undefined) delete process.env.SHELL
  else process.env.SHELL = savedShell
})

describe('buildClaudeLocalSpawn -- the launch shell', () => {
  it('a sh-family $SHELL wins, as a login shell', () => {
    for (const s of ['/opt/homebrew/bin/bash', '/bin/zsh', '/bin/sh']) {
      process.env.SHELL = s
      const { cmd, args } = buildClaudeLocalSpawn({ ...BASE_OPTS })
      expect(cmd, s).toBe(s)
      expect(args).toEqual(['-l'])
    }
  })

  it('a launch line is typed only into a sh-family shell: a fish or pwsh user\'s Claude session runs the sh-family fallback', () => {
    host.present = new Set(['/bin/bash', '/bin/zsh'])
    for (const s of ['/opt/homebrew/bin/fish', '/usr/local/bin/pwsh', '/usr/bin/nu', '/bin/tcsh']) {
      process.env.SHELL = s
      host.platform = 'linux'
      _resetClaudeLoginShellLookupForTest()
      expect(buildClaudeLocalSpawn({ ...BASE_OPTS }), s).toMatchObject({ cmd: '/bin/bash', args: ['-l'] })
      host.platform = 'darwin'
      _resetClaudeLoginShellLookupForTest()
      expect(buildClaudeLocalSpawn({ ...BASE_OPTS }), s).toMatchObject({ cmd: '/bin/zsh', args: ['-l'] })
    }
    // Each of those login shells was asked for its PATH; it gave no answer here.
    expect(new Set(asked.files)).toEqual(new Set(['/opt/homebrew/bin/fish', '/usr/local/bin/pwsh', '/usr/bin/nu', '/bin/tcsh']))
  })

  it('a terminal tab keeps the user\'s own shell, fish or pwsh included, and so does an elevated one', () => {
    for (const s of ['/opt/homebrew/bin/fish', '/usr/local/bin/pwsh']) {
      process.env.SHELL = s
      expect(buildClaudeLocalSpawn({ ...BASE_OPTS, shellOnly: true }), s).toMatchObject({ cmd: s, args: ['-l'] })
      expect(buildClaudeLocalSpawn({ ...BASE_OPTS, shellOnly: true, elevated: true }), s).toMatchObject({ cmd: 'sudo', args: [s, '-l'] })
    }
  })

  it('without $SHELL takes the first of bash, zsh, sh that exists (the probe rule), not a hard-coded bash', () => {
    // bash "absent", zsh present: the old launch would have spawned /bin/bash
    // (ENOENT) on a box whose probe had just passed through zsh
    host.present = new Set(['/bin/zsh'])
    expect(buildClaudeLocalSpawn({ ...BASE_OPTS }).cmd).toBe('/bin/zsh')
    host.present = new Set(['/bin/bash', '/bin/zsh'])
    expect(buildClaudeLocalSpawn({ ...BASE_OPTS }).cmd).toBe('/bin/bash')
    host.present = new Set()
    expect(buildClaudeLocalSpawn({ ...BASE_OPTS }).cmd).toBe('/bin/sh')
  })

  it('macOS without $SHELL is zsh', () => {
    host.platform = 'darwin'
    expect(buildClaudeLocalSpawn({ ...BASE_OPTS }).cmd).toBe('/bin/zsh')
  })

  it('the same shell reaches the shell-only and elevated launches', () => {
    host.present = new Set(['/bin/zsh'])
    expect(buildClaudeLocalSpawn({ ...BASE_OPTS, shellOnly: true })).toMatchObject({ cmd: '/bin/zsh', args: ['-l'] })
    expect(buildClaudeLocalSpawn({ ...BASE_OPTS, shellOnly: true, elevated: true })).toMatchObject({ cmd: 'sudo', args: ['/bin/zsh', '-l'] })
  })

  it('Windows never consults the login shell: PowerShell by its full path in the system folder', () => {
    host.platform = 'win32'
    process.env.SHELL = '/should/be/ignored'
    const savedRoot = process.env.SystemRoot
    process.env.SystemRoot = 'C:\\Windows'
    try {
      const { cmd, args } = buildClaudeLocalSpawn({ ...BASE_OPTS })
      expect(cmd).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
      expect(args).toEqual([])
    } finally {
      if (savedRoot === undefined) delete process.env.SystemRoot
      else process.env.SystemRoot = savedRoot
    }
  })
})
