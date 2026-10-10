// HOST QUARANTINE: starts real processes (git init and git rev-parse in temp folders). [CI] [VM] only -- never run on the owner's machine.
// Ask Conductor's help folder is where git's search for a repository ends.
//
// The folder holds an empty `.git` file among the app's own files, as the
// Insights and Sentinel run folders do. git, started in the folder an Ask
// session runs in, reads that file first and stops there with an error, so it
// finds no repository above the help folder: whatever repository holds the
// resources folder, whatever spelling of the folder git is handed, on every
// platform. The ceiling an
// Ask launch also carries (GIT_CEILING_DIRECTORIES, pty-ask-git-ceiling.test.ts)
// is a second layer; here git runs with no ceiling at all, and with the
// ceiling an Ask launch computes from the spelling it was handed. The file
// is the app's like the others: what a session writes into it, or puts in
// its place, is gone before the next Ask launch reads the folder.
// The real ensureHelpWorkspace over a temporary folder (the owner-only folder
// work is the account store's own, tested there) and the real git, under an
// environment of the test's own: no system or user git settings, no variable
// that names a repository.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../../src/main/debug-logger', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/account-profiles', () => ({
  mkdirSecure: (p: string) => fs.mkdirSync(p, { recursive: true }),
  hardenCredentialDir: () => true,
  atomicWriteSecure: (f: string, d: string | Uint8Array) => fs.writeFileSync(f, d, { flag: 'wx' }),
}))

const { ensureHelpWorkspace } = await import('../../../src/main/help-workspace')

let tmp = ''
/** A repository the resources folder sits inside. */
let outer = ''
let resources = ''
let gitHome = ''

/** git's environment: PATH (to find git) and nothing of this machine's git
 *  set-up -- no system or user settings, no variable naming a repository. */
function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? process.env.Path ?? '',
    HOME: gitHome,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(gitHome, 'gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LANG: 'C',
    ...extra,
  }
  if (process.platform === 'win32') {
    env.SystemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows'
    env.USERPROFILE = gitHome
  }
  return env
}

/** The repository git finds from `cwd`, or null when it finds none. */
function repositoryFrom(cwd: string, extra: Record<string, string> = {}): string | null {
  const r = spawnSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'], { cwd, env: gitEnv(extra), encoding: 'utf8', windowsHide: true })
  if (r.error) throw r.error
  return r.status === 0 ? r.stdout.trim() : null
}

/** `p` in another letter case, when the file system reaches it that way too. */
function otherCaseSpelling(p: string): string | null {
  const flipped = p.replace(/[A-Za-z]/g, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()))
  try { return fs.statSync(flipped).isDirectory() ? flipped : null } catch { return null }
}

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-help-git-')))
  gitHome = path.join(tmp, 'git-home')
  fs.mkdirSync(gitHome)
  fs.writeFileSync(path.join(gitHome, 'gitconfig'), '')
  outer = path.join(tmp, 'Outer')
  resources = path.join(outer, 'Res')
  fs.mkdirSync(resources, { recursive: true })
  execFileSync('git', ['init', '-q', outer], { env: gitEnv(), stdio: 'ignore', windowsHide: true })
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const opts = { appVersion: '9.9.9' }

describe('the help folder ends git\'s search for a repository', () => {
  // Mutation to prove this can fail: leave the `.git` file out of the help folder's files.
  it('holds an empty `.git` file, a plain file and no folder or link, among the app\'s own files', () => {
    const dir = ensureHelpWorkspace(resources, opts)
    const st = fs.lstatSync(path.join(dir, '.git'))
    expect(st.isFile()).toBe(true)
    expect(st.isSymbolicLink()).toBe(false)
    expect(st.size).toBe(0)
  })

  // Mutation to prove this can fail: leave the `.git` file out of the help folder's files.
  it('git started in the help folder finds no repository, with no ceiling at all, though the resources folder sits inside one', () => {
    // The test can fail: a sibling folder of the help folder, the same depth
    // inside the same repository, finds it.
    const sibling = path.join(resources, 'not-help')
    fs.mkdirSync(sibling)
    expect(repositoryFrom(sibling)).not.toBeNull()
    const dir = ensureHelpWorkspace(resources, opts)
    expect(repositoryFrom(dir)).toBeNull()
  })

  it('and under the ceiling an Ask launch computes from the spelling it was handed, in each spelling the file system reaches', () => {
    const dir = ensureHelpWorkspace(resources, opts)
    const spellings = [dir, otherCaseSpelling(dir)].filter((s): s is string => s !== null)
    for (const spelling of spellings) {
      expect(repositoryFrom(spelling), spelling).toBeNull()
      expect(repositoryFrom(spelling, { GIT_CEILING_DIRECTORIES: path.dirname(spelling) }), spelling).toBeNull()
    }
  })

  // Mutation to prove this can fail: leave the `.git` file out of the help folder's files.
  it('a `.git` a session rewrote to name the outer repository, or replaced with a repository of its own, is the empty file again at the next Ask launch', () => {
    const dir = ensureHelpWorkspace(resources, opts)
    const marker = path.join(dir, '.git')
    fs.writeFileSync(marker, `gitdir: ${path.join(outer, '.git')}\n`)
    expect(repositoryFrom(dir)).not.toBeNull()
    ensureHelpWorkspace(resources, opts)
    expect(fs.lstatSync(marker).isFile()).toBe(true)
    expect(fs.statSync(marker).size).toBe(0)
    expect(repositoryFrom(dir)).toBeNull()

    fs.rmSync(marker)
    execFileSync('git', ['init', '-q', dir], { env: gitEnv(), stdio: 'ignore', windowsHide: true })
    expect(fs.lstatSync(marker).isDirectory()).toBe(true)
    ensureHelpWorkspace(resources, opts)
    expect(fs.lstatSync(marker).isFile()).toBe(true)
    expect(fs.statSync(marker).size).toBe(0)
    expect(repositoryFrom(dir)).toBeNull()
  })
})
