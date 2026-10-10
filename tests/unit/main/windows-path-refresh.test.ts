// After an install, the app finds the new tool without a restart (owner
// decision D4, 2026-10-10). Windows gives a new PATH only to programs started
// after the install, so before a check the user asked for (Retry, Check again,
// the check after an install tab ends) main reads the PATH the registry holds
// now and APPENDS the folders it does not have yet. It never drops, reorders
// or rewrites an entry already there, and adds only fully qualified folders.
// PURE: the registry is a stand-in; nothing is started.
import { describe, it, expect, vi } from 'vitest'
import {
  parseRegQueryPath, expandWindowsVariables, mergeWindowsPath, refreshWindowsPathWith, afterPathRefresh, REGISTRY_PATH_KEYS,
} from '../../../src/main/windows-path-refresh'
import { AccountsService, ConsumerLeaseRegistry, SecretHandleStore } from '../../../src/main/providers/core'
import type { ProviderPackage } from '../../../src/main/providers/core'

const BS = String.fromCharCode(92)
const w = (s: string) => s.replace(/\//g, BS) // write Windows paths with forward slashes here
const regOut = (key: string, type: string, data: string) => `\r\n${key}\r\n    Path    ${type}    ${data}\r\n\r\n`

describe('reading a Path value out of reg.exe query', () => {
  it('reads the type and the data, whatever the name is spelled, spaces in the data kept', () => {
    expect(parseRegQueryPath(regOut('HKEY_CURRENT_USER' + BS + 'Environment', 'REG_EXPAND_SZ', w('%USERPROFILE%/.local/bin;C:/Program Files/x')))).toEqual({
      type: 'REG_EXPAND_SZ', data: w('%USERPROFILE%/.local/bin;C:/Program Files/x'),
    })
    expect(parseRegQueryPath('\n    PATH    REG_SZ    C:' + BS + 'Tools\n')).toEqual({ type: 'REG_SZ', data: 'C:' + BS + 'Tools' })
  })

  it('anything else is no value', () => {
    for (const out of ['', 'ERROR: The system was unable to find the specified registry key or value.', '    Path    REG_DWORD    0x1', '    Other    REG_SZ    C:' + BS + 'x']) {
      expect(parseRegQueryPath(out), out).toBeNull()
    }
  })
})

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
  const MACHINE = REGISTRY_PATH_KEYS[0]
  const USER = REGISTRY_PATH_KEYS[1]
  it('reads the system Path then the user Path, as Windows composes them', () => {
    expect(MACHINE).toBe('HKLM' + BS + 'SYSTEM' + BS + 'CurrentControlSet' + BS + 'Control' + BS + 'Session Manager' + BS + 'Environment')
    expect(USER).toBe('HKCU' + BS + 'Environment')
  })

  it('appends what is new to the PATH key the environment already has, expanded, system folders first', async () => {
    const env: Record<string, string | undefined> = { Path: w('C:/Windows/system32;C:/Old'), SystemRoot: w('C:/Windows'), USERPROFILE: w('C:/Users/u') }
    const asked: string[] = []
    const added = await refreshWindowsPathWith({
      platform: 'win32',
      env,
      readValue: async (key) => {
        asked.push(key)
        return key === MACHINE
          ? regOut(key, 'REG_EXPAND_SZ', w('%SystemRoot%/system32;C:/Program Files/nodejs/'))
          : regOut(key, 'REG_EXPAND_SZ', w('%USERPROFILE%/.local/bin;%USERPROFILE%/AppData/Roaming/npm'))
      },
    })
    expect(asked).toEqual([MACHINE, USER])
    expect(added).toEqual([w('C:/Program Files/nodejs/'), w('C:/Users/u/.local/bin'), w('C:/Users/u/AppData/Roaming/npm')])
    expect(env.Path).toBe(w('C:/Windows/system32;C:/Old;C:/Program Files/nodejs/;C:/Users/u/.local/bin;C:/Users/u/AppData/Roaming/npm'))
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['Path'])
  })

  it('a value that cannot be read adds nothing of its own and changes nothing else', async () => {
    const env: Record<string, string | undefined> = { PATH: w('C:/Old') }
    const added = await refreshWindowsPathWith({
      platform: 'win32', env,
      readValue: async (key) => { if (key === MACHINE) throw new Error('reg.exe failed'); return regOut(key, 'REG_SZ', w('C:/User/bin')) },
    })
    expect(added).toEqual([w('C:/User/bin')])
    expect(env.PATH).toBe(w('C:/Old;C:/User/bin'))
    const untouched: Record<string, string | undefined> = { PATH: w('C:/Old') }
    expect(await refreshWindowsPathWith({ platform: 'win32', env: untouched, readValue: async () => null })).toEqual([])
    expect(untouched).toEqual({ PATH: w('C:/Old') })
  })

  it('an environment with no PATH at all gets one named Path', async () => {
    const env: Record<string, string | undefined> = {}
    await refreshWindowsPathWith({ platform: 'win32', env, readValue: async (key) => regOut(key, 'REG_SZ', key === USER ? w('C:/u') : w('C:/m')) })
    expect(env).toEqual({ Path: w('C:/m;C:/u') })
  })

  it('off Windows nothing is read and nothing changes: the login shell PATH is read at each check there', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const env: Record<string, string | undefined> = { PATH: '/usr/bin' }
      const readValue = vi.fn(async () => regOut('x', 'REG_SZ', w('C:/x')))
      expect(await refreshWindowsPathWith({ platform, env, readValue })).toEqual([])
      expect(readValue).not.toHaveBeenCalled()
      expect(env).toEqual({ PATH: '/usr/bin' })
    }
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
