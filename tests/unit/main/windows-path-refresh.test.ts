// After an install, the app finds the new tool without a restart (owner
// decision D4, 2026-10-10). Windows gives a new PATH only to programs started
// after the install, so before a check the user asked for (Check again, the
// check after an install tab ends) main reads the PATH the registry holds now
// and APPENDS the folders it does not have yet. It never drops, reorders or
// rewrites an entry already there, and adds only fully qualified folders. The
// refresh is process-wide: a lookup by name (Claude Code's claude.exe before
// claude.cmd) can then find a claude.exe in an appended folder, as a restart
// would.
// PURE: the registry is a stand-in; nothing is started.
import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { expandWindowsVariables, mergeWindowsPath, refreshWindowsPathWith, afterPathRefresh } from '../../../src/main/windows-path-refresh'
import type { RegistryPaths } from '../../../src/main/windows-registry-path'
import { findClaudeOnWindowsAsync, _resetClaudeWindowsLookupForTest } from '../../../src/main/claude-cli-probe'
import { AccountsService, ConsumerLeaseRegistry, SecretHandleStore } from '../../../src/main/providers/core'
import type { ProviderPackage } from '../../../src/main/providers/core'

const BS = String.fromCharCode(92)
const w = (s: string) => s.replace(/\//g, BS) // write Windows paths with forward slashes here
const ROOT = path.resolve(__dirname, '..', '..', '..')
/** A source file's comments as prose: each line break and comment marker one space. */
const prose = (file: string) => fs.readFileSync(file, 'utf8').replace(/\r?\n\s*(\/\/|\*)?\s*/g, ' ')

describe('expanding a REG_EXPAND_SZ value', () => {
  it('replaces each %NAME% the environment defines, its name in any case; leaves the others as written', () => {
    const env = { USERPROFILE: w('C:/Users/u'), SystemRoot: w('C:/Windows') }
    expect(expandWindowsVariables(w('%userprofile%/.local/bin;%SYSTEMROOT%/system32;%NOPE%/bin'), env)).toBe(w('C:/Users/u/.local/bin;C:/Windows/system32;%NOPE%/bin'))
  })
})

describe('merging the registry PATH into the process PATH', () => {
  it('keeps the current value as it is and appends only the folders it does not have', () => {
    expect(mergeWindowsPath(w('C:/A;C:/B'), [w('C:/B'), w('C:/New')])).toEqual({ value: w('C:/A;C:/B;C:/New'), added: [w('C:/New')] })
  })

  it('never drops, reorders or rewrites an entry already there, even one the registry no longer lists', () => {
    const current = w('C:/Z;relative;%X%/bin;C:/A;"C:/Quoted dir"')
    expect(mergeWindowsPath(current, [w('C:/A')])).toEqual({ value: current, added: [] })
    expect(mergeWindowsPath(current, [])).toEqual({ value: current, added: [] })
    const merged = mergeWindowsPath(current, [w('C:/A'), w('D:/new')])
    expect(merged.value.startsWith(current)).toBe(true)
    expect(merged.value.split(';').slice(0, current.split(';').length)).toEqual(current.split(';'))
  })

  it('compares folders without case, a trailing backslash or quotes', () => {
    expect(mergeWindowsPath(w('C:/Tools/'), [w('c:/tools'), w('"C:/TOOLS"'), w('C:/Tools//')]).added).toEqual([])
  })

  it('adds only fully qualified folders: nothing relative, unexpanded, unreadable, empty or with a control character', () => {
    const fresh = ['bin', w('./x'), w('%NOPE%/bin'), w('C:/Bad') + String.fromCodePoint(0xfffd), '', '   ', w('C:/a') + String.fromCharCode(10) + 'b', w('//server/share/bin'), 'D:/x']
    expect(mergeWindowsPath(w('C:/Windows'), fresh).added).toEqual([w('//server/share/bin'), 'D:/x'])
  })

  it('adds each new folder once, in the order given; an empty or ;-ended PATH gets no empty entry', () => {
    expect(mergeWindowsPath('', [w('C:/a'), w('C:/A'), w('C:/b')])).toEqual({ value: w('C:/a;C:/b'), added: [w('C:/a'), w('C:/b')] })
    expect(mergeWindowsPath(undefined, [w('C:/a')])).toEqual({ value: w('C:/a'), added: [w('C:/a')] })
    expect(mergeWindowsPath(w('C:/x;'), [w('C:/a')])).toEqual({ value: w('C:/x;C:/a'), added: [w('C:/a')] })
  })
})

describe('refreshing the process PATH from the registry', () => {
  const values = (machine: RegistryPaths['machine'], user: RegistryPaths['user']) => async (): Promise<RegistryPaths> => ({ machine, user })

  it('appends what is new to the PATH key the environment already has, expanded, system folders first', async () => {
    const env: Record<string, string | undefined> = { Path: w('C:/Windows/system32;C:/Old'), SystemRoot: w('C:/Windows'), USERPROFILE: w('C:/Users/u') }
    const added = await refreshWindowsPathWith({
      platform: 'win32',
      env,
      readValues: values(
        { kind: 'ExpandString', data: w('%SystemRoot%/system32;C:/Program Files/nodejs/') },
        { kind: 'ExpandString', data: w('%USERPROFILE%/.local/bin;%USERPROFILE%/AppData/Roaming/npm') },
      ),
    })
    expect(added).toEqual([w('C:/Program Files/nodejs/'), w('C:/Users/u/.local/bin'), w('C:/Users/u/AppData/Roaming/npm')])
    expect(env.Path).toBe(w('C:/Windows/system32;C:/Old;C:/Program Files/nodejs/;C:/Users/u/.local/bin;C:/Users/u/AppData/Roaming/npm'))
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['Path'])
  })

  it('a REG_SZ is taken as written; a value of another type adds nothing of its own', async () => {
    const env: Record<string, string | undefined> = { PATH: w('C:/Old'), USERPROFILE: w('C:/Users/u') }
    const added = await refreshWindowsPathWith({
      platform: 'win32', env,
      readValues: values({ kind: 'MultiString', data: w('C:/Multi') }, { kind: 'String', data: w('C:/User/bin;%USERPROFILE%/x') }),
    })
    expect(added).toEqual([w('C:/User/bin')])
    expect(env.PATH).toBe(w('C:/Old;C:/User/bin'))
  })

  it('values that cannot be read add nothing, change nothing, and are reported once with why', async () => {
    const untouched: Record<string, string | undefined> = { PATH: w('C:/Old') }
    const onReadFailure = vi.fn()
    expect(await refreshWindowsPathWith({ platform: 'win32', env: untouched, readValues: async () => { throw new Error('Windows PowerShell was not allowed to run') }, onReadFailure })).toEqual([])
    expect(untouched).toEqual({ PATH: w('C:/Old') })
    expect(onReadFailure).toHaveBeenCalledTimes(1)
    expect(onReadFailure).toHaveBeenCalledWith('Windows PowerShell was not allowed to run')
  })

  it('an environment with no PATH at all gets one named Path', async () => {
    const env: Record<string, string | undefined> = {}
    await refreshWindowsPathWith({ platform: 'win32', env, readValues: values({ kind: 'String', data: w('C:/m') }, { kind: 'String', data: w('C:/u') }) })
    expect(env).toEqual({ Path: w('C:/m;C:/u') })
  })

  it('off Windows nothing is read and nothing changes: the login shell PATH is read at each check there', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const env: Record<string, string | undefined> = { PATH: '/usr/bin' }
      const readValues = vi.fn(values(null, { kind: 'String', data: w('C:/x') }))
      expect(await refreshWindowsPathWith({ platform, env, readValues })).toEqual([])
      expect(readValues).not.toHaveBeenCalled()
      expect(env).toEqual({ PATH: '/usr/bin' })
    }
  })
})

// bypass MAJOR 2 (2026-10-10): a refresh can change what a lookup BY NAME
// finds. Claude Code is looked for as claude.exe in every PATH folder before
// claude.cmd in any, so once %USERPROFILE%\.local\bin (Anthropic's installer's
// claude.exe) is appended, a PATH that found npm's claude.cmd finds that
// claude.exe instead, for every later check and launch: what a restart of
// the app would pick. The header and ADR-024 say so.
describe('the refresh is process-wide, and a lookup by name can then find another program', () => {
  it('npm\'s claude.cmd before the refresh; the appended folder\'s claude.exe after it', async () => {
    _resetClaudeWindowsLookupForTest()
    const npm = w('C:/Users/u/AppData/Roaming/npm')
    const local = w('C:/Users/u/.local/bin')
    const there = new Set([`${npm}${BS}claude.cmd`, `${local}${BS}claude.exe`].map((p) => p.toLowerCase()))
    const stat = async (p: string) => there.has(p.toLowerCase())
    const env: Record<string, string | undefined> = { Path: npm, USERPROFILE: w('C:/Users/u') }
    expect(await findClaudeOnWindowsAsync(env as NodeJS.ProcessEnv, stat)).toBe(`${npm}${BS}claude.cmd`)
    await refreshWindowsPathWith({ platform: 'win32', env, readValues: async () => ({ machine: null, user: { kind: 'ExpandString', data: w('%USERPROFILE%/AppData/Roaming/npm;%USERPROFILE%/.local/bin') } }) })
    expect(env.Path).toBe(`${npm};${local}`)
    expect(await findClaudeOnWindowsAsync(env as NodeJS.ProcessEnv, stat)).toBe(`${local}${BS}claude.exe`)
  })

  it('the header and ADR-024 say so, and no longer promise that a name resolves as before', () => {
    const header = prose(path.join(ROOT, 'src', 'main', 'windows-path-refresh.ts'))
    expect(header).not.toMatch(/What a program name resolves to now is what it resolves to afterwards/)
    expect(header).toMatch(/it is process-wide, and any provider's check runs it/)
    expect(header).toMatch(/claude\.exe in every PATH folder before claude\.cmd in any/)
    const adr = prose(path.join(ROOT, 'architecture', 'decisions', '2026-10-10-adr-024-vendor-installers-may-run-after-confirmation.md'))
    expect(adr).toMatch(/The PATH refresh is process-wide, and any provider's check runs it\./)
    expect(adr).toMatch(/a PATH that resolved to npm's claude\.cmd resolves to that claude\.exe/)
  })

  it('the header no longer says reg.exe loses only what the code page cannot carry: the read keeps every character', () => {
    const header = prose(path.join(ROOT, 'src', 'main', 'windows-path-refresh.ts'))
    expect(header).not.toMatch(/a character it cannot carry arrives as U\+FFFD/)
    expect(header).toMatch(/every character intact/)
  })
})

describe('a check the user asked for looks after the PATH is brought up to date', () => {
  it('afterPathRefresh: the refresh ends before the check starts; a refresh that fails still checks', async () => {
    const order: string[] = []
    const result = await afterPathRefresh(async () => { order.push('check'); return 'found' }, async () => { await Promise.resolve(); order.push('refresh'); return [] })
    expect(result).toBe('found')
    expect(order).toEqual(['refresh', 'check'])
    const failing = await afterPathRefresh(async () => 'checked', async () => { throw new Error('no registry') })
    expect(failing).toBe('checked')
  })

  it("the accounts service's Check again refreshes before its discovery; a refresh that fails still checks", async () => {
    const order: string[] = []
    const pkg = {
      id: 'claude',
      setup: { discover: async () => { order.push('discover'); return { state: 'missing', compatibility: 'unknown', checkedAt: 1 } }, installRecipes: () => [] },
    } as unknown as ProviderPackage
    const service = (refreshPath: () => Promise<unknown>) => new AccountsService({
      store: () => null, leases: new ConsumerLeaseRegistry(), secrets: new SecretHandleStore({ now: () => 0 }),
      packages: () => [pkg], preference: () => 'on', platform: 'win32', randomHex: () => '0'.repeat(32), refreshPath,
    })
    const r = await service(async () => { await Promise.resolve(); order.push('refresh') }).checkAgain('claude')
    expect(r.ok).toBe(true)
    expect(order).toEqual(['refresh', 'discover'])
    order.length = 0
    const again = await service(async () => { throw new Error('no registry') }).checkAgain('claude')
    expect(again.ok).toBe(true)
    expect(order).toEqual(['discover'])
  })
})
