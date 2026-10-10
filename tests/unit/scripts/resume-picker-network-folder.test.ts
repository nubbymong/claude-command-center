// The Claude resume picker in a network folder (scripts/resume-picker.js
// buildSpawnTarget, launchSpec, launchClaude): cmd.exe cannot start in a
// share or a device path (two leading slashes of either kind), so the picker
// never starts an npm claude.cmd there; it says why, and names the two ways
// out. The folder checked is the one the launch starts in: the chosen
// conversation's own folder, else the picker's. The native claude.exe, a
// drive folder and macOS / Linux start as before. Nothing is started; the
// file-system calls that would name a network folder fail the test.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

type Env = Record<string, string | undefined>
type Target = { file: string; argv: string[]; verbatim: boolean; env?: Env }
type SpawnFn = (file: string, args: string[], opts: Record<string, unknown>) => { status: number | null }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const picker = require('../../../scripts/resume-picker.js') as {
  buildSpawnTarget: (cmd: string, args: string[], platform?: string, env?: Env, cwd?: string) => Target | null
  notStartedMessage: (cmd: string | null, args: string[], env?: Env, cwd?: string) => string
  launchSpec: (cmd: string | null, args: string[], base: Record<string, unknown>, platform?: string, env?: Env, where?: string) =>
    { file: string; argv: string[]; opts: Record<string, unknown>; message?: undefined } | { message: string }
  launchClaude: (resumeId: string | undefined, sourceCwd: string | undefined, deps: {
    spawn: SpawnFn; exit: (code: number) => void; argv: string[]; env: Env; platform: string; isFile: (p: string) => boolean; cwd?: string
  }) => void
}

const ENV = { SystemRoot: 'C:\\Windows', Path: 'C:\\npm' }
const SHIM = 'C:\\npm\\claude.cmd'
const EXE = 'C:\\native\\claude.exe'
const SENTENCE = 'Cannot start Claude Code in a network folder through its npm launcher: open the folder from a mapped drive letter, or install the native Claude Code.'
const NETWORK = ['\\\\srv\\share\\project', '//srv/share/project', '\\/srv\\share', '\\\\?\\C:\\project', '\\\\?\\UNC\\srv\\share\\project', '\\\\.\\C:\\project']
const ARGS = ['--model', 'opus']
const BASE = { stdio: 'inherit', shell: false, windowsHide: false }

describe('a network folder on the npm launcher route is refused with the reason', () => {
  it('the shim is never started in a share or a device path, either slash', () => {
    for (const cwd of NETWORK) expect(picker.buildSpawnTarget(SHIM, ARGS, 'win32', ENV, cwd), cwd).toBeNull()
    expect(picker.buildSpawnTarget('C:\\npm\\claude.bat', ARGS, 'win32', ENV, NETWORK[0])).toBeNull()
  })

  it('the reason said is the network folder one there, and each other refusal keeps its own words', () => {
    for (const cwd of NETWORK) expect(picker.notStartedMessage(SHIM, ARGS, ENV, cwd), cwd).toBe(SENTENCE)
    expect(picker.notStartedMessage(SHIM, ['--model', '1%'], ENV, 'C:\\project')).toContain('the value of --model holds')
    expect(picker.notStartedMessage(null, ARGS, ENV, NETWORK[0])).toContain('it was not found in a folder PATH names')
  })

  it('one launch step asks about the folder the launch starts in: the conversation\'s own, else the picker\'s', () => {
    // The conversation's folder is a share: refused, wherever the picker runs.
    expect(picker.launchSpec(SHIM, ARGS, { ...BASE, cwd: NETWORK[0] }, 'win32', ENV, 'C:\\project')).toEqual({ message: SENTENCE })
    // No folder of its own: the picker's, a share here, is the one asked about.
    expect(picker.launchSpec(SHIM, ARGS, BASE, 'win32', ENV, NETWORK[1])).toEqual({ message: SENTENCE })
    // A conversation in a drive folder starts there, even from a picker in a share.
    const started = picker.launchSpec(SHIM, ARGS, { ...BASE, cwd: 'C:\\project-wt' }, 'win32', ENV, NETWORK[0])
    expect('file' in started && started.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect((started as { opts: Record<string, unknown> }).opts.cwd).toBe('C:\\project-wt')
  })
})

describe('everything else starts as before', () => {
  it('the shim starts in a drive folder, exactly as with no folder given', () => {
    const plain = picker.buildSpawnTarget(SHIM, ARGS, 'win32', ENV)
    expect(plain).not.toBeNull()
    for (const cwd of ['C:\\project', 'z:/lower', 'C:\\', undefined]) expect(picker.buildSpawnTarget(SHIM, ARGS, 'win32', ENV, cwd), String(cwd)).toEqual(plain)
  })

  it('the native claude.exe ignores the folder, a network one included', () => {
    for (const cwd of [...NETWORK, 'C:\\project', undefined]) {
      expect(picker.buildSpawnTarget(EXE, ARGS, 'win32', ENV, cwd), String(cwd)).toEqual({ file: EXE, argv: ARGS, verbatim: false })
    }
  })

  it('macOS and Linux: no cmd.exe, nothing changes', () => {
    expect(picker.buildSpawnTarget('claude', ['--resume', 'x'], 'linux', ENV, '//srv/share')).toEqual({ file: 'claude', argv: ['--resume', 'x'], verbatim: false })
  })
})

// Driven through launchClaude: the spawn and the exit are injected, and the
// folder the picker runs in is given. Every file-system call that names a
// network folder throws, so the refusal is shown to come before any of them.
describe('the picker\'s launch from or into a network folder', () => {
  const RESUME = '0f8fad5b-d9cb-469f-a165-70867728950e'
  const isNetwork = (p: unknown) => typeof p === 'string' && /^[\\/]{2}/.test(p)
  const touched: string[] = []
  // The one network folder whose existence a case answers (as the user's share would).
  let existsAnswer: string | null = null
  const spies: Array<{ mockRestore: () => void }> = []
  let drive: string
  beforeEach(() => {
    touched.length = 0
    existsAnswer = null
    drive = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-picker-netfolder-'))
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeFs = require('fs') as typeof import('fs')
    for (const name of ['realpathSync', 'statSync', 'readdirSync', 'mkdirSync', 'existsSync'] as const) {
      const real = nodeFs[name] as (...a: unknown[]) => unknown
      spies.push(vi.spyOn(nodeFs, name).mockImplementation(((...a: unknown[]) => {
        if (name === 'existsSync' && a[0] === existsAnswer) return true
        if (isNetwork(a[0])) { touched.push(`${name} ${String(a[0])}`); throw new Error('no network folder is read here') }
        return real(...a)
      }) as never))
    }
  })
  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore()
    fs.rmSync(drive, { recursive: true, force: true })
  })
  const launch = (o: { resumeId?: string; sourceCwd?: string; cwd: string; isFile?: (p: string) => boolean; env?: Env }) => {
    const calls: Array<{ file: string; opts: Record<string, unknown> }> = []
    const exits: number[] = []
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      picker.launchClaude(o.resumeId, o.sourceCwd, {
        spawn: (file, _args, opts) => { calls.push({ file, opts }); return { status: 0 } },
        exit: (code) => { exits.push(code) },
        argv: ARGS,
        env: o.env ?? ENV,
        platform: 'win32',
        isFile: o.isFile ?? ((p) => p === SHIM),
        cwd: o.cwd,
      })
      return { calls, exits, said: err.mock.calls.map((c) => String(c[0])).join('\n') }
    } finally {
      err.mockRestore()
    }
  }

  it('a new conversation from a picker in a share: refused with the reason, nothing started, nothing read there', () => {
    for (const cwd of NETWORK) {
      const out = launch({ cwd })
      expect(out.calls, cwd).toEqual([])
      expect(out.exits, cwd).toEqual([1])
      expect(out.said, cwd).toContain(SENTENCE)
    }
    expect(touched).toEqual([])
  })

  it('a resume in the picker\'s own share: refused before its companion folder is looked for', () => {
    const out = launch({ resumeId: RESUME, sourceCwd: NETWORK[0], cwd: NETWORK[0] })
    expect(out.calls).toEqual([])
    expect(out.exits).toEqual([1])
    expect(out.said).toContain(SENTENCE)
    expect(touched).toEqual([])
  })

  it('a resume into a conversation folder on a share, from a drive folder: refused', () => {
    existsAnswer = NETWORK[0]
    const out = launch({ resumeId: RESUME, sourceCwd: NETWORK[0], cwd: drive })
    expect(out.calls).toEqual([])
    expect(out.exits).toEqual([1])
    expect(out.said).toContain(SENTENCE)
    expect(touched).toEqual([])
  })

  it('a resume into a drive folder from a picker in a share starts there', () => {
    const out = launch({ resumeId: RESUME, sourceCwd: drive, cwd: NETWORK[0] })
    expect(out.exits).toEqual([0])
    expect(out.calls).toHaveLength(1)
    expect(out.calls[0].file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(out.calls[0].opts.cwd).toBe(drive)
    expect(touched).toEqual([])
  })

  it('the native claude.exe starts in a share as before', () => {
    const out = launch({ cwd: NETWORK[0], env: { ...ENV, Path: 'C:\\npm;C:\\native' }, isFile: (p) => p === EXE || p === SHIM })
    expect(out.exits).toEqual([0])
    expect(out.calls).toEqual([{ file: EXE, opts: { ...BASE, windowsVerbatimArguments: false } }])
  })
})
