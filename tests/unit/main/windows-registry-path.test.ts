// The one helper that reads Windows' PATH values from the registry and
// appends one folder to the user's (ADR-024). Every character survives the
// read (reg.exe printed in the console code page and damaged every one
// outside ASCII); the append writes back exactly what was there with the one
// folder after it, in its own registry type, never a duplicate, and its
// values reach the script only through its environment.
// PURE: Windows PowerShell is a stand-in executor; nothing is started, and
// the real registry is never read or written.
import { describe, it, expect } from 'vitest'
import {
  REGISTRY_PATH_SCRIPT, REGISTRY_PATH_ENV, registryPathToken, parseRegistryPathToken, parseRegistryPathRead, readRegistryPaths,
  planUserPathAppend, appendFolderToUserPath, appendableFolder, type RegistryPaths,
} from '../../../src/main/windows-registry-path'
import { refreshWindowsPathWith } from '../../../src/main/windows-path-refresh'

const BS = String.fromCharCode(92)
const w = (s: string) => s.replace(/\//g, BS)
const E_ACUTE = String.fromCharCode(0xe9)
const JOSE = w(`C:/Users/Jos${E_ACUTE}`)
const KANJI = w('C:/') + String.fromCharCode(0x3042, 0x3044) + w('/bin')

/** What the script prints for a read, as Windows PowerShell would. */
const readOut = (paths: RegistryPaths) => `machine=${registryPathToken(paths.machine)}\r\nuser=${registryPathToken(paths.user)}\r\n`

/** A stand-in Windows PowerShell: answers each call in turn, recording it. */
function executor(answers: string[]) {
  const calls: Array<{ script: string; env: Record<string, string> }> = []
  const run = async (script: string, env: Record<string, string>) => {
    calls.push({ script, env: { ...env } })
    const a = answers.shift()
    if (a === undefined) throw new Error('no answer left')
    return a
  }
  return { run, calls }
}

const fromB64 = (b64: string) => Buffer.from(b64, 'base64').toString('utf16le')

describe('reading the PATH values, every character intact', () => {
  it('a value comes back as its registry type and its UTF-16 text, whatever the console code page', () => {
    const v = { kind: 'ExpandString', data: `${JOSE}${w('/AppData/Roaming/npm')};${KANJI};%USERPROFILE%${w('/.local/bin')}` }
    expect(parseRegistryPathToken(registryPathToken(v))).toEqual(v)
    expect(parseRegistryPathToken('none')).toBeNull()
    for (const bad of ['', 'ExpandString', 'Expand String:AAAA', 'ExpandString:@@@@', 'ExpandString:AAA']) expect(parseRegistryPathToken(bad), bad).toBeUndefined()
  })

  it('a folder with a character outside ASCII survives the read, the parse and the merge into PATH', async () => {
    const npm = `${JOSE}${w('/AppData/Roaming/npm')}`
    const out = readOut({ machine: { kind: 'ExpandString', data: w('%SystemRoot%/system32') }, user: { kind: 'String', data: `${npm};${KANJI}` } })
    const env: Record<string, string | undefined> = { Path: w('C:/Windows/system32'), SystemRoot: w('C:/Windows') }
    const added = await refreshWindowsPathWith({ platform: 'win32', env, readValues: async () => parseRegistryPathRead(out) })
    expect(added).toEqual([npm, KANJI])
    expect(env.Path).toBe(`${w('C:/Windows/system32')};${npm};${KANJI}`)
    expect(env.Path).not.toContain(String.fromCodePoint(0xfffd))
  })

  it('the read runs the one fixed script, with only its mode in the environment', async () => {
    const paths: RegistryPaths = { machine: { kind: 'ExpandString', data: w('C:/m') }, user: null }
    const x = executor([readOut(paths)])
    expect(await readRegistryPaths(x.run)).toEqual(paths)
    expect(x.calls).toEqual([{ script: REGISTRY_PATH_SCRIPT, env: { [REGISTRY_PATH_ENV.mode]: 'read' } }])
  })

  it('an answer that is not the script\'s throws, so the refresh adds nothing and says why', async () => {
    await expect(readRegistryPaths(executor(['nothing useful']).run)).rejects.toThrow()
    await expect(readRegistryPaths(executor(['machine=none\r\n']).run)).rejects.toThrow()
  })

  it('the script reads both values unexpanded and writes only the user Path, in the type it is given', () => {
    expect(REGISTRY_PATH_SCRIPT).toContain('DoNotExpandEnvironmentNames')
    expect(REGISTRY_PATH_SCRIPT).toContain("OpenSubKey('SYSTEM" + BS + 'CurrentControlSet' + BS + 'Control' + BS + "Session Manager" + BS + "Environment', $false)")
    expect(REGISTRY_PATH_SCRIPT).toContain("[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')")
    expect(REGISTRY_PATH_SCRIPT.match(/SetValue\(/g)).toHaveLength(1)
    expect(REGISTRY_PATH_SCRIPT).toContain("$u.SetValue('Path', $next, $kind)")
    expect(REGISTRY_PATH_SCRIPT).not.toMatch(/SetEnvironmentVariable|setx|reg\.exe/i)
    // It refuses to write over a value that changed since it was read.
    expect(REGISTRY_PATH_SCRIPT).toContain(`if ((Token $u) -cne $env:${REGISTRY_PATH_ENV.was}) { 'result=changed'; exit 0 }`)
  })
})

describe('planning the append: exactly one folder, at the end, nothing else changed', () => {
  const env = { USERPROFILE: w('C:/Users/u'), APPDATA: w('C:/Users/u/AppData/Roaming') }
  const FOLDER = w('C:/Users/u/.local/bin')

  it('the user value as stored, then ; and the folder, in the same registry type; %VARIABLES% kept as written', () => {
    const user = { kind: 'ExpandString', data: w('%APPDATA%/npm;C:/Tools;%NOPE%/x') }
    const plan = planUserPathAppend({ machine: null, user }, FOLDER, env)
    expect(plan).toEqual({ kind: 'append', was: registryPathToken(user), next: { kind: 'ExpandString', data: `${user.data};${FOLDER}` } })
    const sz = { kind: 'String', data: w('C:/A;') }
    expect(planUserPathAppend({ machine: null, user: sz }, FOLDER, env)).toMatchObject({ next: { kind: 'String', data: `${w('C:/A;')}${FOLDER}` } })
  })

  it('no user Path yet: one is made with the folder alone, as REG_EXPAND_SZ', () => {
    expect(planUserPathAppend({ machine: null, user: null }, FOLDER, env)).toEqual({ kind: 'append', was: 'none', next: { kind: 'ExpandString', data: FOLDER } })
  })

  it('never a duplicate: case, a trailing backslash, quotes and %VARIABLES% read as Windows reads them, in either PATH', () => {
    for (const data of [w('C:/USERS/U/.LOCAL/BIN'), w('C:/Users/u/.local/bin/'), `"${FOLDER}"`, w('%USERPROFILE%/.local/bin'), w('C:/x;%userprofile%/.local/bin/;C:/y')]) {
      expect(planUserPathAppend({ machine: null, user: { kind: 'ExpandString', data } }, FOLDER, env), data).toEqual({ kind: 'already' })
    }
    expect(planUserPathAppend({ machine: { kind: 'String', data: FOLDER }, user: { kind: 'String', data: w('C:/A') } }, FOLDER, env)).toEqual({ kind: 'already' })
    // A REG_SZ is not expanded by Windows, so a %VARIABLE% there does not name the folder.
    expect(planUserPathAppend({ machine: null, user: { kind: 'String', data: w('%USERPROFILE%/.local/bin') } }, FOLDER, env)).toMatchObject({ kind: 'append' })
  })

  it('a user Path stored as anything but REG_SZ or REG_EXPAND_SZ is not touched', () => {
    expect(planUserPathAppend({ machine: null, user: { kind: 'MultiString', data: 'x' } }, FOLDER, env)).toMatchObject({ kind: 'unsupported' })
  })

  it('only a fully qualified folder that reads as one entry may be appended', () => {
    for (const bad of ['bin', w('./x'), w('C:/a;C:/b'), w('%X%/bin'), w('C:/a"b'), w(' C:/a'), '', w('C:/a') + String.fromCharCode(10), w('C:/a') + String.fromCodePoint(0xfffd)]) {
      expect(appendableFolder(bad), JSON.stringify(bad)).toBe(false)
      expect(planUserPathAppend({ machine: null, user: null }, bad, env), JSON.stringify(bad)).toMatchObject({ kind: 'unsupported' })
    }
    expect(appendableFolder(FOLDER)).toBe(true)
    expect(appendableFolder(`${JOSE}${w('/.local/bin')}`)).toBe(true)
  })
})

describe('appending to the user Path: read, then one compare-and-write, values only in the environment', () => {
  const env = { USERPROFILE: JOSE }
  const FOLDER = `${JOSE}${w('/.local/bin')}`
  const user = { kind: 'ExpandString', data: w('%USERPROFILE%/AppData/Local/Microsoft/WindowsApps;C:/Program Files/Git/cmd') }

  it('writes exactly the value it read with the folder after it, in its type, compared against what it read', async () => {
    const x = executor([readOut({ machine: null, user }), 'result=written\r\nbroadcast=sent\r\n'])
    expect(await appendFolderToUserPath(FOLDER, { run: x.run, env })).toEqual({ outcome: 'added', broadcast: true })
    expect(x.calls).toHaveLength(2)
    const write = x.calls[1]
    expect(write.script).toBe(REGISTRY_PATH_SCRIPT)
    expect(write.script).not.toContain(FOLDER)
    expect(write.env[REGISTRY_PATH_ENV.mode]).toBe('append')
    expect(write.env[REGISTRY_PATH_ENV.was]).toBe(registryPathToken(user))
    expect(write.env[REGISTRY_PATH_ENV.kind]).toBe('ExpandString')
    const next = fromB64(write.env[REGISTRY_PATH_ENV.next])
    expect(next).toBe(`${user.data};${FOLDER}`)
    // Every entry that was there, in its order, then the one folder.
    expect(next.split(';')).toEqual([...user.data.split(';'), FOLDER])
    expect(Object.keys(write.env).sort()).toEqual(Object.values(REGISTRY_PATH_ENV).sort())
  })

  it('already on either Path: nothing is written', async () => {
    const x = executor([readOut({ machine: null, user: { kind: 'ExpandString', data: `${user.data};${w('%USERPROFILE%/.local/bin')}` } })])
    expect(await appendFolderToUserPath(FOLDER, { run: x.run, env })).toEqual({ outcome: 'already' })
    expect(x.calls).toHaveLength(1)
  })

  it('a value that changed between the read and the write is read again once; still changing, nothing is written', async () => {
    const moved = { kind: 'ExpandString', data: `${user.data};${w('D:/new')}` }
    const x = executor([readOut({ machine: null, user }), 'result=changed\r\n', readOut({ machine: null, user: moved }), 'result=written\r\nbroadcast=failed\r\n'])
    expect(await appendFolderToUserPath(FOLDER, { run: x.run, env })).toEqual({ outcome: 'added', broadcast: false })
    expect(fromB64(x.calls[3].env[REGISTRY_PATH_ENV.next])).toBe(`${moved.data};${FOLDER}`)
    const y = executor([readOut({ machine: null, user }), 'result=changed\r\n', readOut({ machine: null, user }), 'result=changed\r\n'])
    expect(await appendFolderToUserPath(FOLDER, { run: y.run, env })).toEqual({ outcome: 'changed' })
  })

  it('an answer it does not know is an error, never taken as written', async () => {
    await expect(appendFolderToUserPath(FOLDER, { run: executor([readOut({ machine: null, user }), 'result=unknown-mode\r\n']).run, env })).rejects.toThrow()
  })
})
