// ADR-025: the Accounts panel's `claude auth status` starts a claude.exe found
// in PATH's folders directly on Windows, on the main thread. Before that start
// it awaits the first-start warm-up of that same program, with Claude's
// --version environment (never the account's home); an npm claude.cmd
// (started through cmd.exe) is not warmed. The lookup, the warm-up and the
// CLI start are faked and the platform is forced: nothing is started.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => ({
  root: '',
  bin: 'C:\\Users\\A\\.local\\bin\\claude.exe',
  order: [] as string[],
  warm: [] as Array<{ program: string; env: () => unknown }>,
  gate: null as null | Promise<void>,
}))
type ExecCb = (err: Error | null, res?: { stdout: string; stderr: string }) => void
vi.mock('node:child_process', () => ({
  execFile: (file: string, _args: string[], _opts: unknown, cb: ExecCb) => {
    h.order.push(`start ${file}`)
    cb(null, { stdout: JSON.stringify({ loggedIn: true }), stderr: '' })
  },
}))
vi.mock('../../../src/main/claude-cli-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/claude-cli-probe')>()),
  recentClaudeOnWindows: () => h.bin,
  findClaudeOnWindowsAsync: async () => h.bin,
}))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/managed-launch-diagnostics', () => ({ gateManagedLaunch: async () => ({ status: 'clean' }), peekGateVerdict: () => ({ status: 'clean' }) }))
vi.mock('../../../src/main/account-profiles', async () => ({
  ...(await vi.importActual<typeof import('../../../src/main/account-profiles')>('../../../src/main/account-profiles')),
  getProfilesRoot: () => h.root,
  getProfileConfigDir: (id: string) => join(h.root, id),
  withProfileHome: (env: Record<string, string>) => env,
  profileCredentialFoldersChecked: () => true,
}))
vi.mock('../../../src/main/first-start-warmup', () => ({
  warmFirstStart: async (program: string, env: () => unknown) => {
    h.warm.push({ program, env })
    h.order.push(`warm ${program}`)
    if (h.gate) await h.gate
    return { outcome: 'ran', exitCode: 0, timedOut: false }
  },
}))

const { readClaudeCliAuth } = await import('../../../src/main/account-web/claude-cli-auth')

const ID = 'profile-abc-123'
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const savedRoot = process.env.SystemRoot
beforeEach(() => {
  h.root = fs.mkdtempSync(join(os.tmpdir(), 'ccc-first-start-auth-'))
  fs.mkdirSync(join(h.root, ID))
  h.bin = 'C:\\Users\\A\\.local\\bin\\claude.exe'
  h.order.length = 0
  h.warm.length = 0
  h.gate = null
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  process.env.SystemRoot = 'C:\\Windows'
})
afterEach(() => {
  Object.defineProperty(process, 'platform', hostPlatform)
  if (savedRoot === undefined) delete process.env.SystemRoot
  else process.env.SystemRoot = savedRoot
  delete process.env.CCC_FIRST_START_MARK
  // TEST CLEANUP GUARD: only this suite's own folder, by its prefix and parent.
  if (h.root.startsWith(join(os.tmpdir(), 'ccc-first-start-auth-'))) fs.rmSync(h.root, { recursive: true, force: true })
})

describe('the Accounts panel\'s claude auth status on Windows (ADR-025)', () => {
  it('awaits the warm-up of the claude.exe found in PATH\'s folders before it starts it', async () => {
    let release!: () => void
    h.gate = new Promise<void>((r) => { release = r })
    const read = readClaudeCliAuth(ID)
    await vi.waitFor(() => expect(h.warm).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(h.order).toEqual([`warm ${h.bin}`])
    release()
    expect((await read).source).toBe('cli-status')
    expect(h.order).toEqual([`warm ${h.bin}`, `start ${h.bin}`])
  })

  it('warms with Claude\'s --version environment, never the account\'s home', async () => {
    process.env.CCC_FIRST_START_MARK = 'never reaches a CLI run'
    await readClaudeCliAuth(ID)
    const env = (await (h.warm[0].env as () => Promise<{ env: Record<string, string> }> | { env: Record<string, string> })()).env
    expect(Object.keys(env).some((k) => k.toUpperCase().startsWith('CCC_'))).toBe(false)
    expect(env.NoDefaultCurrentDirectoryInExePath).toBe('1')
    expect(JSON.stringify(env)).not.toContain(h.root.replace(/\\/g, '\\\\'))
  })

  it('an npm claude.cmd, which cmd.exe starts, is not warmed', async () => {
    h.bin = 'C:\\Npm\\claude.cmd'
    await readClaudeCliAuth(ID)
    expect(h.warm).toEqual([])
    expect(h.order).toEqual(['start C:\\Windows\\System32\\cmd.exe'])
  })
})
