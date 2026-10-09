import { describe, it, expect, vi, beforeEach } from 'vitest'

// The local-git runner's starts are recorded; no process starts.
const h = vi.hoisted(() => ({ spawn: [] as Array<{ file: string; args: string[]; opts: Record<string, any> }>, exit: 0, out: 'https://github.com/a/b.git\n' }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: (file: string, args: string[], opts: Record<string, any>) => {
    h.spawn.push({ file, args, opts })
    const on: Record<string, (v: any) => void> = {}
    const outOn: Record<string, (v: any) => void> = {}
    queueMicrotask(() => { outOn.data?.(Buffer.from(h.out)); on.close?.(h.exit) })
    return { stdout: { on: (ev: string, fn: (v: any) => void) => { outOn[ev] = fn } }, stderr: { on: vi.fn() }, on: (ev: string, fn: (v: any) => void) => { on[ev] = fn } }
  },
}))

import { detectRepoFromCwd, defaultGitRun, GIT_RUN_PREFIX } from '../../../src/main/github/session/repo-detector'

beforeEach(() => { h.spawn.length = 0; h.exit = 0; h.out = 'https://github.com/a/b.git\n' })

describe('detectRepoFromCwd', () => {
  it('parses git remote output', async () => {
    const run = vi.fn().mockResolvedValue('https://github.com/a/b.git\n')
    expect(await detectRepoFromCwd('/x', run)).toBe('a/b')
  })
  it('returns null on git error', async () => {
    const run = vi.fn().mockRejectedValue(new Error('no git'))
    expect(await detectRepoFromCwd('/x', run)).toBeNull()
  })
  it('returns null for non-github remote', async () => {
    const run = vi.fn().mockResolvedValue('https://gitlab.com/a/b.git\n')
    expect(await detectRepoFromCwd('/x', run)).toBeNull()
  })
  it('parses SSH remote', async () => {
    const run = vi.fn().mockResolvedValue('git@github.com:a/b.git\n')
    expect(await detectRepoFromCwd('/x', run)).toBe('a/b')
  })
})

describe('git is run by its absolute path from PATH\'s folders', () => {
  /** A file test over a set, with a git in every relative entry (never to be chosen). */
  const files = (...real: string[]) => {
    const set = new Set(['git.exe', '.\\git.exe', 'rel\\bin\\git.exe', 'git', './git', 'rel/git', ...real].map((p) => p.toLowerCase()))
    return (p: string) => set.has(p.toLowerCase())
  }

  it('Windows: the git.exe in PATH\'s first absolute folder that has it, no shell, no current-folder lookup, no pager or fsmonitor', async () => {
    const run = defaultGitRun({ platform: 'win32', env: { Path: '.;rel\\bin;%X%\\bin;C:\\Git\\cmd;D:\\Other' }, isFile: files('C:\\Git\\cmd\\git.exe', 'D:\\Other\\git.exe') })
    expect(await detectRepoFromCwd('C:\\repo', run)).toBe('a/b')
    expect(h.spawn).toHaveLength(1)
    const { file, args, opts } = h.spawn[0]
    expect(file).toBe('C:\\Git\\cmd\\git.exe')
    expect(args).toEqual(['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', 'remote', 'get-url', 'origin'])
    expect(opts.shell).toBe(false)
    expect(opts.cwd).toBe('C:\\repo')
    expect(opts.env.NoDefaultCurrentDirectoryInExePath).toBe('1')
  })

  it('Windows: the setting that keeps the project folder out of program lookup is one spelling, and the env passed in is left as it was', async () => {
    const env = { Path: 'C:\\Git\\cmd', NODEFAULTCURRENTDIRECTORYINEXEPATH: '' }
    const run = defaultGitRun({ platform: 'win32', env, isFile: files('C:\\Git\\cmd\\git.exe') })
    await run('C:\\repo', ['status', '--porcelain'])
    expect(h.spawn[0].opts.env).toEqual({ Path: 'C:\\Git\\cmd', NoDefaultCurrentDirectoryInExePath: '1' })
    expect(env).toEqual({ Path: 'C:\\Git\\cmd', NODEFAULTCURRENTDIRECTORYINEXEPATH: '' })
  })

  it('macOS/Linux: the git in PATH\'s first absolute folder that has it, with the same switches', async () => {
    const run = defaultGitRun({ platform: 'linux', env: { PATH: '.:rel:/usr/local/bin:/usr/bin' }, isFile: files('/usr/bin/git') })
    await run('/repo', ['status', '--porcelain'])
    expect(h.spawn[0].file).toBe('/usr/bin/git')
    expect(h.spawn[0].args).toEqual([...GIT_RUN_PREFIX, 'status', '--porcelain'])
    expect(h.spawn[0].opts.shell).toBe(false)
  })

  it('no git in PATH\'s absolute folders (only in relative entries): the run rejects and nothing starts', async () => {
    const run = defaultGitRun({ platform: 'win32', env: { PATH: '.;rel\\bin' }, isFile: files() })
    await expect(run('C:\\repo', ['remote', 'get-url', 'origin'])).rejects.toThrow(/git was not found/)
    expect(await detectRepoFromCwd('C:\\repo', run)).toBeNull()
    expect(h.spawn).toEqual([])
  })

  it('a git log run shows no signatures, whatever the repository\'s own configuration says', async () => {
    const run = defaultGitRun({ platform: 'linux', env: { PATH: '/usr/bin' }, isFile: files('/usr/bin/git') })
    await run('/repo', ['log', '-5', '--format=%H'])
    const args = h.spawn[0].args
    const log = args.indexOf('log')
    expect(args.slice(0, log)).toEqual(expect.arrayContaining(['-c', 'log.showSignature=false']))
    expect(args.indexOf('log.showSignature=false')).toBe(args.indexOf('-c', args.indexOf('core.fsmonitor=false')) + 1)
  })

  it('a non-zero exit still rejects with git\'s own message', async () => {
    h.exit = 128
    const run = defaultGitRun({ platform: 'linux', env: { PATH: '/usr/bin' }, isFile: files('/usr/bin/git') })
    await expect(run('/repo', ['rev-parse', 'HEAD'])).rejects.toThrow(/git exited 128/)
  })
})
