// Ask Conductor's conversation list stays inside its help folder, and the
// picker's git is found in PATH's folders.
//
// - The git a managed launch runs to list the resume picker's worktrees (the
//   list the launch is checked for) is the git the picker itself runs: by its
//   full path from a folder PATH names, never a bare name, with the picker's
//   arguments (no pager, no file-system monitor hook from the repository's
//   settings), and on Windows with NoDefaultCurrentDirectoryInExePath=1, so
//   nothing it starts by name comes from the project folder.
// - An Ask Conductor launch carries GIT_CEILING_DIRECTORIES = the help folder's
//   parent, in the session's environment (which the picker it runs inherits)
//   and in that worktree listing: git looks for a repository in the help
//   folder alone, even when the resources folder is inside one. A session that
//   is not Ask's carries none.
// The real spawnPty over a temporary folder; the account is a folder there;
// node-pty and the git child process record, nothing is started.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROFILE = 'profile-askceil-0001'
const h = vi.hoisted(() => ({
  root: '',
  ptyEnvs: [] as Array<Record<string, string | undefined>>,
  gitCalls: [] as Array<{ file: string; args: string[]; env: Record<string, string | undefined>; cwd: string }>,
  /** Any other program a child-process call asked for (refused, never run). */
  otherChildren: [] as string[],
  /** The environment the session's launcher would inherit. */
  providerEnv: {} as Record<string, string>,
}))
vi.mock('electron', () => ({
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  nativeTheme: { shouldUseDarkColors: false, on() {} },
  app: { getPath: () => process.env.TEMP, getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
}))
vi.mock('node-pty', () => ({ spawn: (_file: string, _args: unknown, opts: { env: Record<string, string | undefined> }) => {
  h.ptyEnvs.push({ ...opts.env })
  return { pid: 4747, cols: 80, rows: 24, process: 'sh',
    onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
    write() {}, resize() {}, kill() {}, pause() {}, resume() {}, clear() {} }
} }))
// The git child the worktree listing starts: recorded, answered with nothing.
// Any other child is recorded and refused, never started: nothing in this
// file runs a program on this machine (afterEach checks there was none).
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>()
  const execFile = ((file: string, args: string[], opts: { env: Record<string, string | undefined>; cwd: string }, cb?: (e: Error | null, out: string) => void) => {
    if (!Array.isArray(args) || !args.includes('worktree')) {
      h.otherChildren.push(String(file))
      setImmediate(() => cb?.(new Error('no other program is started in this test'), ''))
      return { unref() {}, on() {}, kill() {} }
    }
    h.gitCalls.push({ file, args: [...args], env: { ...opts.env }, cwd: opts.cwd })
    setImmediate(() => cb?.(null, ''))
    return { unref() {}, on() {} }
  }) as unknown as typeof real.execFile
  return { ...real, execFile, default: { ...real, execFile } }
})
// The account: a folder under the test's own root. Its home is passed
// through as it is (the owner-only folder work is the account store's own,
// tested there).
vi.mock('../../src/main/account-profiles', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/account-profiles')>()
  const nodePath = require('path') as typeof import('path')
  return {
    ...real,
    isValidProfileId: (id: string) => id === 'profile-askceil-0001',
    getProfileConfigDir: (id: string) => nodePath.join(h.root, 'profiles', id),
    getPrimaryProfileId: () => null,
    setupProfileLinks: () => {}, syncPrimaryCredentialsWithGlobal: () => {}, backupProfileHomeToCanonical: () => {},
    withProfileHome: (env: Record<string, string>) => ({ ...env }),
  }
})
vi.mock('../../src/main/managed-launch-diagnostics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/managed-launch-diagnostics')>()),
  gateManagedLaunchDirs: async () => ({ status: 'clean' }),
}))
vi.mock('../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => h.root, getDataDirectory: () => h.root, registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {}, logDebug: () => {} }))
vi.mock('../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null, getTranscriptBinder: () => null }))
vi.mock('../../src/main/conductor-mcp-server', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../src/main/conductor-mcp-server')>()), getConductorMcpPort: () => 0 }))
vi.mock('../../src/main/providers', () => ({
  getProvider: () => ({ resolveBinary: () => ({ cmd: 'claude', source: 'system' }), buildSpawnCommand: () => ({ cmd: 'sh', args: [], env: { ...h.providerEnv } }), ingestSessionTelemetry: () => ({ stop: () => {} }) }),
}))
vi.mock('../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => null }))
vi.mock('../../src/main/hooks', () => ({ getGateway: () => null, isExactBindSourceActive: () => true }))
vi.mock('../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => null, removeLocalSessionSettings: () => {}, writeLocalSessionMcpConfig: () => null, removeLocalSessionMcpConfig: () => {}, removeLocalSessionStatusUrl: () => {},
}))
vi.mock('../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => {}, clearClaudeAccount: () => {}, getAccountIdentity: () => null, pushAccountIdentity: () => {}, startWatchingAccountIdentity: () => {}, stopWatchingAccountIdentity: () => {}, getWatchedProfileId: () => null,
}))
vi.mock('../../src/main/session-registry', () => ({ updateSessionMeta: () => {}, clearSessionMeta: () => {}, markPtySessionAlive: () => {}, markPtySessionGone: () => {}, isPtySessionLive: () => true }))
vi.mock('../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/config-manager')>()),
  readConfig: () => ({}),
  readConfigChecked: () => ({ value: {}, outcome: 'ok' }),
  getConfigDir: () => h.root,
}))

const { spawnPty, killPty, pickerGitPath, askGitEnvironment, askGitCeiling, _setPickerGitLookupForTest } = await import('../../src/main/pty-manager')

const win = { webContents: { send: () => {} }, isDestroyed: () => false } as never
const until = async (cond: () => boolean, why: string): Promise<void> => {
  const deadline = Date.now() + 5000
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
  if (!cond()) throw new Error(`timed out waiting: ${why}`)
}
/** The value of `name` in `env`, by its Windows name in any case. */
const envValue = (env: Record<string, string | undefined>, name: string): string | undefined =>
  Object.entries(env).find(([k]) => (process.platform === 'win32' ? k.toUpperCase() === name.toUpperCase() : k === name))?.[1]

const GIT = path.resolve(os.tmpdir(), 'ccc-picker-git-stand-in', process.platform === 'win32' ? 'git.exe' : 'git')
let help = ''
const SIDS = ['askceil-ask', 'askceil-plain']

beforeEach(() => {
  h.root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pty-ask-ceiling-')))
  help = path.join(h.root, 'resources', 'help')
  fs.mkdirSync(help, { recursive: true })
  fs.mkdirSync(path.join(h.root, 'profiles', PROFILE), { recursive: true })
  h.ptyEnvs = []; h.gitCalls = []; h.otherChildren = []; h.providerEnv = {}
  // The picker's git, as the lookup by the picker's rule finds it.
  _setPickerGitLookupForTest(async () => GIT)
})
afterEach(() => {
  for (const id of SIDS) { try { killPty(id) } catch { /* not started */ } }
  _setPickerGitLookupForTest(null)
  fs.rmSync(h.root, { recursive: true, force: true })
  expect(h.otherChildren).toEqual([])
})

describe('the picker list a managed launch is checked for', () => {
  // Mutation to prove this can fail: start git by its bare name again.
  it('runs git by the full path found in PATH\'s folders, with the picker\'s arguments', async () => {
    spawnPty(win, 'askceil-plain', { profileId: PROFILE, cwd: help, useResumePicker: true })
    await until(() => h.gitCalls.length > 0, 'the worktree listing')
    const call = h.gitCalls[0]
    expect(call.file).toBe(GIT)
    expect(call.args).toEqual(['--no-pager', '-c', 'core.fsmonitor=false', 'worktree', 'list', '--porcelain'])
    expect(call.cwd).toBe(help)
    if (process.platform === 'win32') {
      expect(Object.keys(call.env).filter((k) => k.toUpperCase() === 'NODEFAULTCURRENTDIRECTORYINEXEPATH')).toEqual(['NoDefaultCurrentDirectoryInExePath'])
      expect(call.env.NoDefaultCurrentDirectoryInExePath).toBe('1')
    }
  })

  it('no git in PATH\'s folders: no listing, and the launch goes on', async () => {
    _setPickerGitLookupForTest(async () => null)
    spawnPty(win, 'askceil-plain', { profileId: PROFILE, cwd: help, useResumePicker: true })
    await until(() => h.ptyEnvs.length > 0, 'the session to start')
    expect(h.gitCalls).toEqual([])
  })
})

describe('an Ask Conductor launch is kept inside its help folder', () => {
  // Mutation to prove this can fail: drop the ceiling from the session's environment.
  it('the session carries GIT_CEILING_DIRECTORIES = the help folder\'s parent', async () => {
    spawnPty(win, 'askceil-ask', { profileId: PROFILE, cwd: help, isAsk: true })
    await until(() => h.ptyEnvs.length > 0, 'the Ask session to start')
    expect(envValue(h.ptyEnvs[0], 'GIT_CEILING_DIRECTORIES')).toBe(path.dirname(help))
  })

  it('an Ask launch with no account carries it too', () => {
    spawnPty(win, 'askceil-ask', { cwd: help, isAsk: true })
    expect(envValue(h.ptyEnvs[0], 'GIT_CEILING_DIRECTORIES')).toBe(path.dirname(help))
  })

  // Mutation to prove this can fail: drop the ceiling from the listing's environment.
  it('the picker list its launch is checked for is listed under the same ceiling', async () => {
    spawnPty(win, 'askceil-ask', { profileId: PROFILE, cwd: help, isAsk: true, useResumePicker: true })
    await until(() => h.gitCalls.length > 0, 'the worktree listing')
    expect(envValue(h.gitCalls[0].env, 'GIT_CEILING_DIRECTORIES')).toBe(path.dirname(help))
    await until(() => h.ptyEnvs.length > 0, 'the Ask session to start')
    expect(envValue(h.ptyEnvs[0], 'GIT_CEILING_DIRECTORIES')).toBe(path.dirname(help))
  })

  it('a session that is not Ask\'s carries no ceiling of the app\'s', async () => {
    spawnPty(win, 'askceil-plain', { profileId: PROFILE, cwd: help, useResumePicker: true })
    await until(() => h.ptyEnvs.length > 0, 'the session to start')
    expect(envValue(h.ptyEnvs[0], 'GIT_CEILING_DIRECTORIES')).toBeUndefined()
    expect(envValue(h.gitCalls[0].env, 'GIT_CEILING_DIRECTORIES')).toBeUndefined()
  })
})

describe('an Ask launch\'s git finds a repository only from where it starts', () => {
  // Mutation to prove this can fail: keep the inherited repository variables.
  it('the session carries none of the variables that name a repository; another session keeps them', () => {
    h.providerEnv = { GIT_DIR: '/elsewhere/.git', GIT_WORK_TREE: '/elsewhere', GIT_COMMON_DIR: '/elsewhere/.git' }
    spawnPty(win, 'askceil-ask', { cwd: help, isAsk: true })
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) expect(envValue(h.ptyEnvs[0], name)).toBeUndefined()
    expect(envValue(h.ptyEnvs[0], 'GIT_CEILING_DIRECTORIES')).toBe(path.dirname(help))
    spawnPty(win, 'askceil-plain', { cwd: help })
    expect(envValue(h.ptyEnvs[1], 'GIT_DIR')).toBe('/elsewhere/.git')
  })

  it('the environment the picker list is made under follows the same rule, in every spelling on Windows', () => {
    const env = { PATH: 'p', GIT_DIR: 'a', git_work_tree: 'b', Git_Common_Dir: 'c', git_ceiling_directories: 'd' }
    expect(askGitEnvironment(env, 'C:\\res', 'win32')).toEqual({ PATH: 'p', GIT_CEILING_DIRECTORIES: 'C:\\res' })
    // Elsewhere names are case-sensitive: git reads the upper-case ones only.
    expect(askGitEnvironment(env, '/res', 'linux')).toEqual({ PATH: 'p', git_work_tree: 'b', Git_Common_Dir: 'c', git_ceiling_directories: 'd', GIT_CEILING_DIRECTORIES: '/res' })
    expect(env.GIT_DIR).toBe('a')
  })
})

describe('an Ask launch whose help folder git cannot be kept inside is refused, saying what to change', () => {
  const exactly = (s: string): RegExp => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
  const separatorSentence = (sep: string): string => `Cannot start Ask Conductor on Claude Code: the resources folder's path holds a '${sep}', which git reads as a list of folders: choose a resources folder whose path has none.`
  const controlSentence = 'Cannot start Ask Conductor on Claude Code: the resources folder\'s path holds a control character: choose a resources folder whose path has none.'
  const notAbsoluteSentence = 'Cannot start Ask Conductor on Claude Code: its help folder is not an absolute path.'

  // Mutation to prove this can fail: drop the list separator check.
  it('a resources folder whose path holds the list separator', () => {
    expect(() => askGitCeiling('C:\\a;b\\help', 'win32')).toThrow(exactly(separatorSentence(';')))
    expect(() => askGitCeiling('/a:b/help', 'linux')).toThrow(exactly(separatorSentence(':')))
  })

  it('a resources folder whose path holds a control character', () => {
    expect(() => askGitCeiling(`/a${String.fromCharCode(7)}b/help`, 'linux')).toThrow(exactly(controlSentence))
    expect(() => askGitCeiling(`C:\\a${String.fromCharCode(127)}b\\help`, 'win32')).toThrow(exactly(controlSentence))
  })

  it('a help folder that is not an absolute path', () => {
    expect(() => askGitCeiling('help', 'linux')).toThrow(exactly(notAbsoluteSentence))
    expect(() => askGitCeiling('C:help', 'win32')).toThrow(exactly(notAbsoluteSentence))
    expect(() => askGitCeiling('\\help', 'win32')).toThrow(exactly(notAbsoluteSentence))
  })

  it('an ordinary help folder: git stops at its parent', () => {
    expect(askGitCeiling('C:\\Users\\me\\My Resources\\help', 'win32')).toBe('C:\\Users\\me\\My Resources')
    expect(askGitCeiling('/home/me/My Resources/help', 'linux')).toBe('/home/me/My Resources')
  })

  it('the launch is refused with that sentence and starts nothing', () => {
    const sep = process.platform === 'win32' ? ';' : ':'
    const refusedHelp = path.join(h.root, `re${sep}sources`, 'help')
    fs.mkdirSync(refusedHelp, { recursive: true })
    expect(() => spawnPty(win, 'askceil-ask', { cwd: refusedHelp, isAsk: true })).toThrow(exactly(separatorSentence(sep)))
    expect(h.ptyEnvs).toEqual([])
  })
})

describe('the picker\'s git lookup (the picker\'s own rule)', () => {
  const yes = (hits: string[]) => async (p: string): Promise<boolean> => hits.includes(p)

  it('POSIX: only an absolute folder PATH names is read', async () => {
    const env = { PATH: 'relative/bin::.:/opt/git/bin:/usr/bin' }
    expect(await pickerGitPath(env, 'linux', yes(['relative/bin/git', 'git', './git', '/opt/git/bin/git', '/usr/bin/git']))).toBe('/opt/git/bin/git')
    expect(await pickerGitPath(env, 'linux', yes(['relative/bin/git', './git']))).toBeNull()
  })

  // The real file test off Windows: a file named git the user may not run is
  // passed over, as the system's own lookup (and the picker) passes it over.
  it.skipIf(process.platform === 'win32')('POSIX: a git the user may not run is passed over for a later folder\'s', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-picker-git-'))
    try {
      const first = path.join(base, 'first'); const second = path.join(base, 'second')
      fs.mkdirSync(first); fs.mkdirSync(second)
      fs.writeFileSync(path.join(first, 'git'), '', { mode: 0o644 })
      fs.writeFileSync(path.join(second, 'git'), '', { mode: 0o755 })
      expect(await pickerGitPath({ PATH: `${first}:${second}` }, 'linux')).toBe(path.posix.join(second, 'git'))
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it('Windows: only a fully qualified folder with no unexpanded variable is read', async () => {
    const env = { Path: '.;bin;%TOOLS%\\git;C:\\Program Files\\Git\\cmd' }
    expect(await pickerGitPath(env, 'win32', yes(['.\\git.exe', 'bin\\git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe']))).toBe('C:\\Program Files\\Git\\cmd\\git.exe')
    expect(await pickerGitPath(env, 'win32', yes(['.\\git.exe', 'bin\\git.exe']))).toBeNull()
  })
})
