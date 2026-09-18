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

const { buildClaudeLocalSpawn } = await import('../../../../src/main/providers/claude/spawn')

const BASE_OPTS = { sessionId: 'ses-1', cwd: '/work', cols: 80, rows: 24 }
const savedShell = process.env.SHELL

beforeEach(() => {
  host.platform = 'linux'
  host.present = new Set()
  delete process.env.SHELL
})
afterEach(() => {
  if (savedShell === undefined) delete process.env.SHELL
  else process.env.SHELL = savedShell
})

describe('buildClaudeLocalSpawn -- the launch shell', () => {
  it('$SHELL wins, as a login shell', () => {
    process.env.SHELL = '/opt/fish'
    const { cmd, args } = buildClaudeLocalSpawn({ ...BASE_OPTS })
    expect(cmd).toBe('/opt/fish')
    expect(args).toEqual(['-l'])
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

  it('Windows never consults the login shell', () => {
    host.platform = 'win32'
    process.env.SHELL = '/should/be/ignored'
    const { cmd, args } = buildClaudeLocalSpawn({ ...BASE_OPTS })
    expect(cmd).toBe('powershell.exe')
    expect(args).toEqual([])
  })
})
