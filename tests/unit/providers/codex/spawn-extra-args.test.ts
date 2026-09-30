// P3.11 (row 62): a Codex session's extra CLI arguments reach the launch as a
// Claude session's do: after every flag the app sets, each word one argument,
// on every route (a direct launch, a resume by id, the picker, and the npm
// .cmd shim through cmd.exe). No shell reads a Codex launch, so a word needs
// no quoting; the builder checks the value again (the spawn schema's rule) and
// refuses the launch as the schema does. Nothing is started: the node lookup
// is a fake.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs'
import { join, basename, dirname } from 'path'
import { tmpdir } from 'os'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execSync: vi.fn(() => (process.platform === 'win32' ? 'C:\\node\\node.exe\n' : '/usr/local/bin/node\n')) }
})
vi.mock('../../../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => (globalThis as any).__mockResourcesDir ?? '',
  getDataDirectory: () => (globalThis as any).__mockResourcesDir ?? '',
}))
vi.mock('../../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => (globalThis as any).__mockMcpPort ?? 0,
  mcpSessionToken: () => 'tok',
  issueMcpSessionToken: () => 'tok',
}))
vi.mock('../../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/config-manager')>()),
  readConfig: () => ({}),
  getConfigDir: () => '/cfg',
}))
const RESUME_ID = '0199a5e1-2f3b-7c4d-8e5f-60718293a4b5'
vi.mock('../../../../src/main/providers/codex/rollout-lookup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/providers/codex/rollout-lookup')>()),
  resolveCodexResume: (target: { uuid: string } | undefined) => (target
    ? { resumeId: target.uuid, cwd: '', cwdMismatch: false, path: '/res/r1/sessions/rollout.jsonl' }
    : null),
}))

import { CodexProvider } from '../../../../src/main/providers/codex'

const TEST_PREFIX = 'p311-extra-args-'
const made: string[] = []
function resources(files: string[]): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), TEST_PREFIX)))
  made.push(d)
  mkdirSync(join(d, 'scripts'), { recursive: true })
  for (const f of files) writeFileSync(join(d, 'scripts', f), '// test copy')
  ;(globalThis as any).__mockResourcesDir = d
  return d
}
afterEach(() => {
  ;(globalThis as any).__mockResourcesDir = undefined
  ;(globalThis as any).__mockMcpPort = undefined
  // TEST CLEANUP GUARD: only the folders this test made, by their own prefix, under the temp folder.
  for (const d of made.splice(0)) {
    if (!basename(d).startsWith(TEST_PREFIX) || dirname(d) !== realpathSync.native(tmpdir())) continue
    rmSync(d, { recursive: true, force: true })
  }
})

function withWin32<T>(fn: () => T): T {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  try { return fn() } finally { if (orig) Object.defineProperty(process, 'platform', orig) }
}
function withPlatform<T>(p: NodeJS.Platform, fn: () => T): T {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
  try { return fn() } finally { if (orig) Object.defineProperty(process, 'platform', orig) }
}

const posix = { executable: '/opt/codex/bin/codex', env: { PATH: '/usr/bin', CODEX_HOME: '/res/r1' }, sessionsDir: '/res/r1/sessions' }
const winEnv = { SystemRoot: 'C:\\Windows', CODEX_HOME: 'C:\\res\\r1' }
const co = (extraArgs?: string) => ({ model: 'gpt-5.5', reasoningEffort: 'high' as const, permissionsPreset: 'standard' as const, ...(extraArgs !== undefined ? { extraArgs } : {}) })
const build = (opts: Record<string, unknown>) => new CodexProvider().buildSpawnCommand({ sessionId: 'sid', realmLaunch: posix, ...opts } as any)

describe('a direct launch', () => {
  it('appends each word as one argument, after every flag the app sets (the MCP server included)', () => {
    ;(globalThis as any).__mockMcpPort = 4321
    const out = withPlatform('linux', () => build({ codexOptions: co('--search  --add-dir /srv/shared -i shot.png') }))
    expect(out.cmd).toBe('/opt/codex/bin/codex')
    expect(out.args.slice(-5)).toEqual(['--search', '--add-dir', '/srv/shared', '-i', 'shot.png'])
    const appFlags = out.args.slice(0, -5)
    expect(appFlags).toContain('--ask-for-approval')
    expect(appFlags.some((a) => a.startsWith('mcp_servers.conductor.url='))).toBe(true)
    expect(out.args).not.toContain('')
  })

  it('adds nothing for none, an empty value or spaces only (the launch is what it was)', () => {
    const base = withPlatform('linux', () => build({ codexOptions: co() })).args
    for (const v of ['', '   ']) expect(withPlatform('linux', () => build({ codexOptions: co(v) })).args, JSON.stringify(v)).toEqual(base)
  })

  it('after the hooks too, when the launch carries them (on this host\'s own platform, as spawn-hooks.test.ts)', () => {
    resources(['ccc-codex-hook.js', 'ccc-codex-hook.cmd'])
    const host = process.platform === 'win32'
      ? { ...posix, executable: 'C:\\codex\\codex.exe', env: { ...winEnv, PATH: 'C:\\Windows' } }
      : posix
    const out = build({ realmLaunch: host, codexOptions: co('--no-alt-screen'), codexHooks: { hookFile: join(tmpdir(), 'x', 'hook.json') } })
    expect(out.hooksInstalled).toBe(true)
    expect(out.args[out.args.length - 1]).toBe('--no-alt-screen')
    expect(out.args.slice(0, -1).some((a) => a.startsWith('hooks.'))).toBe(true)
  })

  it('a Windows codex.exe gets them as arguments too, backslash paths unchanged', () => {
    const out = withWin32(() => build({ realmLaunch: { ...posix, executable: 'C:\\codex\\codex.exe', env: winEnv }, codexOptions: co('--add-dir F:\\shared_libs') }))
    expect(out.cmd).toBe('C:\\codex\\codex.exe')
    expect(out.commandLine).toBeUndefined()
    expect(out.args.slice(-2)).toEqual(['--add-dir', 'F:\\shared_libs'])
  })
})

describe('a resume by id', () => {
  it('keeps resume and the id first, and the words last', () => {
    const out = withPlatform('linux', () => build({ codexOptions: co('--search'), resume: { uuid: RESUME_ID, cwd: '/w' } }))
    expect(out.resumeId).toBe(RESUME_ID)
    expect(out.args.slice(0, 2)).toEqual(['resume', RESUME_ID])
    expect(out.args[out.args.length - 1]).toBe('--search')
  })
})

describe('the picker', () => {
  it('is handed the words after the app flags, and forwards them as they are', () => {
    resources(['codex-resume-picker.js'])
    const out = withPlatform('linux', () => build({ useResumePicker: true, codexOptions: co('--search --add-dir ./docs') }))
    expect(out.args[0]).toMatch(/codex-resume-picker\.js$/)
    expect(out.args.slice(-3)).toEqual(['--search', '--add-dir', './docs'])
  })
})

describe('the npm .cmd shim through cmd.exe', () => {
  const shim = { ...posix, executable: 'C:\\npm\\codex.cmd', env: winEnv }
  it('carries the words at the end of the one verbatim line', () => {
    const out = withWin32(() => build({ realmLaunch: shim, codexOptions: { permissionsPreset: 'standard', extraArgs: '--add-dir=F:\\shared_libs --search' } }))
    expect(out.commandLine).toBe('/d /v:off /s /c ""C:\\npm\\codex.cmd" --sandbox workspace-write --ask-for-approval on-request --add-dir=F:\\shared_libs --search"')
  })
  it('the picker on that route carries them too', () => {
    resources(['codex-resume-picker.js'])
    const out = withWin32(() => build({ realmLaunch: shim, useResumePicker: true, codexOptions: co('--search') }))
    expect(out.args[out.args.length - 1]).toBe('--search')
  })
})

describe('the builder refuses what the spawn schema refuses, whichever route', () => {
  const refused = ['--model=x', '-c model=x', '--yolo', '--cd=/tmp', '--profile=p', 'login', '--add-dir docs', '--add-dir a;b', '--add-dir x\\', '-hm']
  for (const v of refused) {
    it(`refuses ${JSON.stringify(v)}, naming it`, () => {
      expect(() => withPlatform('linux', () => build({ codexOptions: co(v) }))).toThrow(/^Cannot start Codex: its extra CLI arguments are refused/)
      expect(() => withWin32(() => build({ realmLaunch: { ...posix, executable: 'C:\\npm\\codex.cmd', env: winEnv }, codexOptions: co(v) }))).toThrow(/extra CLI arguments/)
    })
  }
  it('the message names the argument', () => {
    expect(() => withPlatform('linux', () => build({ codexOptions: co('--search --yolo') }))).toThrow(/--yolo/)
  })
})
