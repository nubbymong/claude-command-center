// [host] WP2 PR 4 (owner answers, 2026-10-04): the Codex executable on Windows
// is found as a terminal finds it, PATH order first: the first PATH entry
// holding codex.exe or codex.cmd wins, and within one entry the PATHEXT order
// decides (src/main/providers/codex/spawn.ts resolveCodexBinary). The lookup
// reads only fully qualified PATH entries (a drive or a share), starts no
// process and no shell, and
// finds no less than before (a form PATHEXT does not list still counts, after
// the listed ones). The file system is a fixed set of paths, so nothing on
// this machine is looked up.
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, platform: vi.fn(() => 'win32') }
})
// The earlier lookup asked `where codex.exe`, then `where codex.cmd`: this
// stands in for it, answering with the codex.exe of the LATER entry.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execSync: vi.fn((cmd: string) => (String(cmd).includes('codex.exe') ? 'C:\\later\\codex.exe\r\n' : 'C:\\earlier\\codex.cmd\r\n')) }
})
vi.mock('../../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '', getDataDirectory: () => '' }))
vi.mock('../../../../src/main/conductor-mcp-server', () => ({ getConductorMcpPort: () => 0, issueMcpSessionToken: () => 'tok' }))

const { execSync } = await import('child_process')
const { resolveCodexBinary } = await import('../../../../src/main/providers/codex/spawn')

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC'
let asked: string[]

/** The files that exist, case-insensitively, as on NTFS. */
function onDisk(...files: string[]): (p: string) => boolean {
  const set = new Set(files.map((f) => f.toLowerCase()))
  return (p: string) => { asked.push(p); return set.has(p.toLowerCase()) }
}
const resolve = (env: Record<string, string>, ...files: string[]) =>
  resolveCodexBinary({ platform: 'win32', env, isFile: onDisk(...files) })

beforeEach(() => {
  asked = []
  vi.mocked(execSync).mockClear()
})

describe('PATH order wins (owner, 2026-10-04)', () => {
  it('[host] a codex.cmd in an earlier PATH entry wins over a codex.exe in a later one', () => {
    expect(resolve({ PATH: 'C:\\earlier;C:\\later', PATHEXT: DEFAULT_PATHEXT }, 'C:\\earlier\\codex.cmd', 'C:\\later\\codex.exe')).toEqual({ cmd: 'C:\\earlier\\codex.cmd', args: [] })
  })

  it('[host] a codex.exe in an earlier PATH entry wins over a codex.cmd in a later one', () => {
    expect(resolve({ PATH: 'C:\\earlier;C:\\later', PATHEXT: DEFAULT_PATHEXT }, 'C:\\earlier\\codex.exe', 'C:\\later\\codex.cmd')).toEqual({ cmd: 'C:\\earlier\\codex.exe', args: [] })
  })

  it.each([
    ['the default PATHEXT (.EXE before .CMD)', DEFAULT_PATHEXT, 'codex.exe'],
    ['a PATHEXT listing .CMD before .EXE', '.COM;.CMD;.EXE', 'codex.cmd'],
    ['no PATHEXT at all (Windows\' own default)', undefined, 'codex.exe'],
    ['a PATHEXT in lower case', '.cmd;.exe', 'codex.cmd'],
  ])('[host] both in one entry: the PATHEXT order decides (%s)', (_name, pathExt, want) => {
    const env: Record<string, string> = { PATH: 'C:\\npm' }
    if (pathExt !== undefined) env.PATHEXT = pathExt
    expect(resolve(env, 'C:\\npm\\codex.exe', 'C:\\npm\\codex.cmd')?.cmd).toBe(`C:\\npm\\${want}`)
  })

  it('[host] a form PATHEXT does not list still counts, after the ones it lists: nothing found before is lost', () => {
    expect(resolve({ PATH: 'C:\\npm', PATHEXT: '.CMD' }, 'C:\\npm\\codex.exe', 'C:\\npm\\codex.cmd')?.cmd).toBe('C:\\npm\\codex.cmd')
    expect(resolve({ PATH: 'C:\\bin', PATHEXT: '.CMD' }, 'C:\\bin\\codex.exe')?.cmd).toBe('C:\\bin\\codex.exe')
  })

  it('[host] the variable\'s name is matched as Windows matches it (Path)', () => {
    expect(resolve({ Path: 'C:\\earlier;C:\\later', PathExt: DEFAULT_PATHEXT }, 'C:\\later\\codex.exe')?.cmd).toBe('C:\\later\\codex.exe')
  })

  it('[host] a quoted entry is read without its quotes, and a trailing separator is harmless', () => {
    expect(resolve({ PATH: '"C:\\Program Files\\codex cli";C:\\later\\', PATHEXT: DEFAULT_PATHEXT }, 'C:\\Program Files\\codex cli\\codex.cmd', 'C:\\later\\codex.exe')?.cmd).toBe('C:\\Program Files\\codex cli\\codex.cmd')
  })

  it('[host] a share (UNC) entry is read like any folder', () => {
    expect(resolve({ PATH: '\\\\server\\tools;C:\\later', PATHEXT: DEFAULT_PATHEXT }, '\\\\server\\tools\\codex.cmd', 'C:\\later\\codex.exe')?.cmd).toBe('\\\\server\\tools\\codex.cmd')
  })

  it('[host] nothing found anywhere: null', () => {
    expect(resolve({ PATH: 'C:\\a;C:\\b', PATHEXT: DEFAULT_PATHEXT })).toBeNull()
    expect(resolve({ PATHEXT: DEFAULT_PATHEXT })).toBeNull()
  })
})

describe('the protections the lookup keeps', () => {
  it('[host] only fully qualified PATH folders (a drive or a share) are read', () => {
    const out = resolve({ PATH: ';.;bin;.\\tools;\\rooted;C:relative;C:\\later', PATHEXT: DEFAULT_PATHEXT }, 'codex.cmd', '.\\codex.cmd', 'bin\\codex.cmd', '\\rooted\\codex.cmd', 'C:relative\\codex.cmd', 'C:\\later\\codex.exe')
    expect(out?.cmd).toBe('C:\\later\\codex.exe')
    expect(asked.every((p) => /^[A-Za-z]:\\/.test(p))).toBe(true)
  })

  it('[host] no shell and no process: nothing is started to look Codex up on Windows', () => {
    resolve({ PATH: 'C:\\earlier;C:\\later', PATHEXT: DEFAULT_PATHEXT }, 'C:\\later\\codex.exe')
    resolve({ PATH: 'C:\\a', PATHEXT: DEFAULT_PATHEXT })
    expect(execSync).not.toHaveBeenCalled()
  })

  it('[host] only codex.exe and codex.cmd are looked for: no other PATHEXT form, and no extensionless file', () => {
    expect(resolve({ PATH: 'C:\\npm', PATHEXT: DEFAULT_PATHEXT }, 'C:\\npm\\codex', 'C:\\npm\\codex.bat', 'C:\\npm\\codex.com', 'C:\\npm\\codex.ps1')).toBeNull()
    expect(asked.map((p) => p.toLowerCase()).sort()).toEqual(['c:\\npm\\codex.cmd', 'c:\\npm\\codex.exe'])
  })
})
