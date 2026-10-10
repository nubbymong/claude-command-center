// The Codex resume picker in a network folder (scripts/lib/codex-resume-picker-lib.js
// launchTarget, scripts/codex-resume-picker.js): cmd.exe cannot start in a
// share or a device path, so the picker never starts Codex's npm launcher
// there; it says why, in the
// sentence the app's own launch uses. The standalone codex.exe, a drive
// folder and macOS / Linux start as before. Pure; nothing is started.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require('../../../scripts/lib/codex-resume-picker-lib.js') as {
  launchTarget: (cmd: string, args: string[], platform: string, env: Record<string, string | undefined>, cwd?: string) => null | { file: string; args: string[]; verbatim: boolean }
  launchRefusal: (cmd: string, platform: string, cwd?: string) => string
}

const env = { SystemRoot: 'C:\\Windows' }
const SHIM = 'C:\\npm\\codex.cmd'
const EXE = 'C:\\a\\codex.exe'
const SENTENCE = 'Cannot start Codex in a network folder through its npm launcher: open the folder from a mapped drive letter, or install the standalone Codex.'
const NO_FOLDER = 'Cannot start Codex through its npm launcher without a folder to start it in.'
const NETWORK = ['\\\\srv\\share\\project', '//srv/share/project', '\\/srv\\share', '\\\\?\\C:\\project', '\\\\?\\UNC\\srv\\share\\project', '\\\\.\\C:\\project']

describe('a network folder on the npm launcher route is refused with the reason', () => {
  it('the shim is never started in a share or a device path, either slash', () => {
    for (const cwd of NETWORK) expect(lib.launchTarget(SHIM, ['-m', 'gpt-5.5'], 'win32', env, cwd), cwd).toBeNull()
  })

  it('nor where its start folder is not known', () => {
    expect(lib.launchTarget(SHIM, ['-m', 'gpt-5.5'], 'win32', env)).toBeNull()
    expect(lib.launchTarget(SHIM, ['-m', 'gpt-5.5'], 'win32', env, '')).toBeNull()
  })

  it('the reason said is the network folder one there, and the cmd.exe one for anything else refused', () => {
    for (const cwd of NETWORK) expect(lib.launchRefusal(SHIM, 'win32', cwd), cwd).toBe(SENTENCE)
    expect(lib.launchRefusal(SHIM, 'win32', 'C:\\project')).toMatch(/cmd\.exe/)
    expect(lib.launchRefusal(EXE, 'win32', '\\\\srv\\share')).toMatch(/cmd\.exe/)
  })

  it('with no start folder given, the reason said is that one', () => {
    for (const cwd of [undefined, '']) expect(lib.launchRefusal(SHIM, 'win32', cwd), String(cwd)).toBe(NO_FOLDER)
    expect(lib.launchRefusal(EXE, 'win32')).toMatch(/cmd\.exe/)
  })

  it('the sentence is the one the app\'s own launch uses', () => {
    const spawn = readFileSync(join(__dirname, '../../../src/main/providers/codex/spawn.ts'), 'utf8')
    expect(spawn).toContain(`'${SENTENCE}'`)
  })
})

describe('everything else starts as before', () => {
  it('the shim starts in a drive folder', () => {
    expect(lib.launchTarget(SHIM, ['-m', 'gpt-5.5'], 'win32', env, 'C:\\project')).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/v:off', '/s', '/c', `""${SHIM}" -m gpt-5.5"`], verbatim: true,
    })
  })

  it('the standalone codex.exe ignores the folder, a network one included', () => {
    for (const cwd of [...NETWORK, 'C:\\project', undefined]) {
      expect(lib.launchTarget(EXE, ['-m', 'gpt-5.5'], 'win32', env, cwd), String(cwd)).toEqual({ file: EXE, args: ['-m', 'gpt-5.5'], verbatim: false })
    }
  })

  it('macOS and Linux: no cmd.exe, nothing changes', () => {
    expect(lib.launchTarget('/usr/bin/codex', ['resume', 'x'], 'linux', env, '//srv/share')).toEqual({ file: '/usr/bin/codex', args: ['resume', 'x'], verbatim: false })
  })
})

describe('the picker passes the folder Codex starts in (source wiring)', () => {
  const script = readFileSync(join(__dirname, '../../../scripts/codex-resume-picker.js'), 'utf8')
  const launch = script.slice(script.indexOf('function launchCodex('))

  it('the folder asked about is the one spawnSync starts in: the pick\'s own, else the current one', () => {
    expect(launch).toContain('const where = retarget.cwd || process.cwd()')
    expect(launch).toContain('lib.launchTarget(cmd, args, os.platform(), process.env, where)')
    expect(launch).toMatch(/spawnSync\(target\.file, target\.args, \{[^}]*\.\.\.\(retarget\.cwd \? \{ cwd: retarget\.cwd \} : \{\}\)/)
  })

  it('a refusal says its reason', () => {
    expect(launch).toContain('console.error(`\\n  ${lib.launchRefusal(cmd, os.platform(), where)}\\n`)')
  })
})
