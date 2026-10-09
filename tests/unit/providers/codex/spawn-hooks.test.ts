// P3.10 (rows 43, 46, 47, 63): a Codex launch carries the app's hooks when main
// hands it a hook file (the Hooks gateway on and listening), as a Claude launch
// carries its http hooks in its settings file: the same command for every
// session (Codex's trust of a reviewed hook lasts while it is unchanged), the
// session named by the environment the hook inherits (its id, and the hook
// file's path; never the token). None without a hook file, before the
// forwarder is deployed, or when the command cannot be given safely on the
// launch's route.
// P3.10 round 1: through the npm .cmd shim from a resources folder whose path
// is not a plain word, the launch runs the app's plain-path copy of the
// wrapper under the user's local app data folder, checked before each use
// (V3); the picker is told which conversations other tabs are on, and Codex
// is not (V2). Nothing is started: the node lookup is a fake.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync } from 'fs'
import { join, basename, dirname } from 'path'
import { tmpdir } from 'os'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execSync: vi.fn(() => (process.platform === 'win32' ? 'C:\\node\\node.exe\n' : '/usr/local/bin/node\n')) }
})
vi.mock('../../../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => (globalThis as any).__mockResourcesDir ?? '',
  getDataDirectory: () => (globalThis as any).__mockResourcesDir ?? '',
}))
vi.mock('../../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  mcpSessionToken: () => 'tok',
  issueMcpSessionToken: () => 'tok',
}))
const warns = vi.hoisted(() => [] as string[])
vi.mock('../../../../src/main/debug-logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/debug-logger')>()),
  logWarn: (...a: unknown[]) => { warns.push(a.map(String).join(' ')) },
}))
// [host] The real logger kept above keeps its log inside the test's own folder, never
// the installed app's (tests/helpers/test-data-dir.ts).
const TEST_DATA = await vi.hoisted(async () => (await import('../../../helpers/test-data-dir')).useTestDataDirectory())
vi.mock('../../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/config-manager')>()),
  readConfig: () => ({}),
  // The built-in tools switches' checked read: a fresh install, so no
  // settings file on disk decides it.
  readConfigChecked: () => ({ outcome: 'absent', value: null }),
  getConfigDir: () => (globalThis as any).__mockResourcesDir ?? '/cfg',
}))

import { CodexProvider } from '../../../../src/main/providers/codex'
import { codexHookCommand, codexHookConfigArgs, codexPlainWrapperDir, __setCodexLocalAppDataForTests, __resetCodexHookFoldersForTests, CODEX_HOOK_FILE_ENV, CODEX_HOOK_FOLDERS_RETRY_MS } from '../../../../src/main/providers/codex/hooks'
import { codexCmdExeTarget, CODEX_OPEN_ELSEWHERE_ENV } from '../../../../src/main/providers/codex/spawn'

const TEST_PREFIX = 'p310-spawn-hooks-'
const made: string[] = []
function tempDir(): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), TEST_PREFIX)))
  made.push(d)
  return d
}
function resources(deploy = true, sub?: string): string {
  const top = tempDir()
  const d = sub ? join(top, sub) : top
  mkdirSync(join(d, 'scripts'), { recursive: true })
  if (deploy) {
    writeFileSync(join(d, 'scripts', 'ccc-codex-hook.js'), '// test copy')
    writeFileSync(join(d, 'scripts', 'ccc-codex-hook.cmd'), 'rem test copy')
  }
  ;(globalThis as any).__mockResourcesDir = d
  return d
}
afterEach(() => {
  vi.useRealTimers()
  ;(globalThis as any).__mockResourcesDir = undefined
  __setCodexLocalAppDataForTests(null)
  __resetCodexHookFoldersForTests()
  warns.length = 0
  // TEST CLEANUP GUARD: only the folders this test made, by their own prefix, under the temp folder.
  for (const d of made.splice(0)) {
    if (!basename(d).startsWith(TEST_PREFIX) || dirname(d) !== realpathSync.native(tmpdir())) continue
    rmSync(d, { recursive: true, force: true })
  }
})

const exe = process.platform === 'win32' ? 'C:\\codex\\codex.exe' : '/opt/codex/bin/codex'
const launch = { executable: exe, env: { PATH: process.platform === 'win32' ? 'C:\\Windows' : '/usr/bin', CODEX_HOME: '/res/r1', SystemRoot: 'C:\\Windows' }, sessionsDir: '/res/r1/sessions' }
const hookFile = join(tmpdir(), 'codex-hooks', 'ccc-codex-hook-abc', 'hook.json')
const opts = { sessionId: 'sess-1', realmLaunch: launch, codexOptions: { permissionsPreset: 'standard' as const } }
const ID = '019dd000-0001-7000-8000-0000000000c1'
const ID_B = '019dd000-0001-7000-8000-0000000000c2'

/** Round 4: the owner-only rule, answered here: each folder made when missing,
 *  `ok` its verdict. */
function secureWith(ok: boolean) {
  return async (dirs: readonly string[]) => dirs.map((dir) => {
    try { mkdirSync(dir) } catch { /* there already */ }
    return { dir, ok, detail: ok ? 'owner-only' : 'not this user\'s alone' }
  })
}

function hookArgs(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) if (args[i] === '-c' && /^hooks\./.test(args[i + 1] ?? '')) out.push(args[i + 1])
  return out
}
/** The picker, deployed (a stub), so a launch through it is visible. */
function deployPicker(res: string): void {
  writeFileSync(join(res, 'scripts', 'codex-resume-picker.js'), '// stub')
}
/** A realm in `res` with this conversation's rollout, run in `cwd`. */
function realmWith(res: string, id: string, cwd: string): string {
  const at = new Date(Date.now() - 2 * 24 * 3600 * 1000)
  const sessions = join(res, 'realm', 'sessions')
  const dir = join(sessions, String(at.getUTCFullYear()), String(at.getUTCMonth() + 1).padStart(2, '0'), String(at.getUTCDate()).padStart(2, '0'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `rollout-2026-09-25T10-00-00-${id}.jsonl`), JSON.stringify({ timestamp: at.toISOString(), type: 'session_meta', payload: { id, cwd, cli_version: '0.155.1' } }) + '\n')
  return sessions
}

describe('buildCodexSpawn: the app\'s hooks', () => {
  it('with a hook file: the six hooks, the hook file named in the environment, and hooksInstalled', () => {
    const res = resources()
    const out = new CodexProvider().buildSpawnCommand({ ...opts, codexHooks: { hookFile } })
    const command = codexHookCommand(join(res, 'scripts'), process.platform, false)!
    expect(command).not.toBeNull()
    expect(hookArgs(out.args)).toEqual(hookArgs(codexHookConfigArgs(command)))
    expect(hookArgs(out.args).length).toBe(6)
    expect(out.env[CODEX_HOOK_FILE_ENV]).toBe(hookFile)
    expect(out.env.CLAUDE_MULTI_SESSION_ID).toBe('sess-1')
    expect(out.hooksInstalled).toBe(true)
    // The token is never on the command line or in the environment.
    expect(JSON.stringify(out)).not.toMatch(/0f8b6a2c|token/i)
  })

  it('without a hook file (the Hooks gateway off or not listening): no hooks, nothing named', () => {
    resources()
    const out = new CodexProvider().buildSpawnCommand(opts)
    expect(hookArgs(out.args)).toEqual([])
    expect(out.env[CODEX_HOOK_FILE_ENV]).toBeUndefined()
    expect(out.hooksInstalled).toBe(false)
  })

  it('before the forwarder is deployed: no hooks (Codex would run a missing command)', () => {
    resources(false)
    const out = new CodexProvider().buildSpawnCommand({ ...opts, codexHooks: { hookFile } })
    expect(hookArgs(out.args)).toEqual([])
    expect(out.env[CODEX_HOOK_FILE_ENV]).toBeUndefined()
    expect(out.hooksInstalled).toBe(false)
  })

  it('a hook file path that is not absolute, or holds a control character, is not handed on', () => {
    resources()
    for (const bad of ['hook.json', `${hookFile}\n`]) {
      const out = new CodexProvider().buildSpawnCommand({ ...opts, codexHooks: { hookFile: bad } })
      expect(out.hooksInstalled, JSON.stringify(bad)).toBe(false)
      expect(out.env[CODEX_HOOK_FILE_ENV]).toBeUndefined()
    }
  })

  it('the resume picker and an exact resume forward the same hooks as a direct launch (round 1, N1: each built as named)', () => {
    const res = resources()
    deployPicker(res)
    const direct = new CodexProvider().buildSpawnCommand({ ...opts, codexHooks: { hookFile } })
    const picker = new CodexProvider().buildSpawnCommand({ ...opts, useResumePicker: true, codexHooks: { hookFile } })
    expect(basename(picker.args[0])).toBe('codex-resume-picker.js')
    expect(hookArgs(picker.args)).toEqual(hookArgs(direct.args))
    expect(picker.hooksInstalled).toBe(true)
    const sessionsDir = realmWith(res, ID, res)
    const exact = new CodexProvider().buildSpawnCommand({ ...opts, realmLaunch: { ...launch, sessionsDir }, resume: { uuid: ID, cwd: res }, codexHooks: { hookFile } })
    expect(exact.resumeId).toBe(ID)
    expect(exact.args.slice(0, 2)).toEqual(['resume', ID])
    expect(hookArgs(exact.args)).toEqual(hookArgs(direct.args))
    expect(exact.hooksInstalled).toBe(true)
  })

  it('round 1 (V2): the picker is told which conversations other tabs are on (ids only, bounded); Codex itself is not', () => {
    const res = resources()
    deployPicker(res)
    const picker = new CodexProvider().buildSpawnCommand({ ...opts, useResumePicker: true, codexOpenElsewhere: [ID, 'not-an-id', ID_B] })
    expect(picker.env[CODEX_OPEN_ELSEWHERE_ENV]).toBe(`${ID},${ID_B}`)
    const none = new CodexProvider().buildSpawnCommand({ ...opts, useResumePicker: true, codexOpenElsewhere: [] })
    expect(none.env[CODEX_OPEN_ELSEWHERE_ENV]).toBeUndefined()
    const direct = new CodexProvider().buildSpawnCommand({ ...opts, codexOpenElsewhere: [ID] })
    expect(direct.env[CODEX_OPEN_ELSEWHERE_ENV]).toBeUndefined()
  })

  it.runIf(process.platform === 'win32')('Windows, through the npm .cmd shim: a plain wrapper path passes cmd.exe; a path with a space gives no hooks, and the launch still starts', () => {
    const res = resources()
    const shim = 'C:\\npm\\codex.cmd'
    const plain = codexHookCommand(join(res, 'scripts'), 'win32', true)
    const out = new CodexProvider().buildSpawnCommand({ ...opts, realmLaunch: { ...launch, executable: shim }, codexHooks: { hookFile } })
    if (plain) {
      expect(out.hooksInstalled).toBe(true)
      expect(() => codexCmdExeTarget(shim, hookArgs(codexHookConfigArgs(plain)).flatMap((a) => ['-c', a]), launch.env)).not.toThrow()
    } else {
      expect(out.hooksInstalled).toBe(false)
    }
    expect(out.commandLine).toBeTruthy()
  })
})

describe('round 1 (V3): the npm shim route from a resources folder with a space', () => {
  it.runIf(process.platform === 'win32')('runs the plain-path copy under the local app data folder once staged and checked; a changed copy, none staged, or a spaced local app data folder gives no hooks; a direct launch keeps PowerShell\'s call', async (ctx) => {
    const res = resources(true, 'AI Code Conductor')
    const lad = tempDir()
    __setCodexLocalAppDataForTests(lad)
    const plainDir = codexPlainWrapperDir(lad, res)
    // Where this host's test folders have no plain-word path there is nothing to show.
    if (!plainDir) { ctx.skip(); return }
    const shim = 'C:\\npm\\codex.cmd'
    const viaShim = () => new CodexProvider().buildSpawnCommand({ ...opts, realmLaunch: { ...launch, executable: shim }, codexHooks: { hookFile } })
    // Not staged yet: no hooks, and the launch still starts.
    const before = viaShim()
    expect(before.hooksInstalled).toBe(false)
    expect(before.commandLine).toBeTruthy()
    expect(await new CodexProvider().prepareHookFolders(res, secureWith(true))).toBe(true)
    const out = viaShim()
    expect(out.hooksInstalled).toBe(true)
    const command = join(plainDir, 'ccc-codex-hook.cmd')
    expect(out.commandLine).toContain(`command='${command}'`)
    expect(out.commandLine).not.toContain('AI Code Conductor')
    expect(out.env[CODEX_HOOK_FILE_ENV]).toBe(hookFile)
    // A copy changed since it was staged is never run.
    writeFileSync(join(plainDir, 'ccc-codex-hook.cmd'), 'rem someone else')
    expect(viaShim().hooksInstalled).toBe(false)
    // A local app data folder whose path has a space: no plain copy, no hooks.
    __setCodexLocalAppDataForTests(join(lad, 'Riley Smith'))
    expect(viaShim().hooksInstalled).toBe(false)
    // A direct launch from the spaced resources folder is PowerShell's call of its own path, as before.
    const direct = new CodexProvider().buildSpawnCommand({ ...opts, codexHooks: { hookFile } })
    expect(direct.hooksInstalled).toBe(true)
    expect(hookArgs(direct.args)).toEqual(hookArgs(codexHookConfigArgs(`& '${join(res, 'scripts', 'ccc-codex-hook.cmd')}'`)))
  })
})

describe('round 2 (R7): a plain-path copy that could not be made is said', () => {
  it.runIf(process.platform === 'win32')('the preparation logs it, and the shim route then has no hooks', async (ctx) => {
    const res = resources(true, 'AI Code Conductor')
    const lad = tempDir()
    __setCodexLocalAppDataForTests(lad)
    if (!codexPlainWrapperDir(lad, res)) { ctx.skip(); return }
    // The owner-only rule does not take: nothing staged, and it says so.
    await new CodexProvider().prepareHookFolders(res, secureWith(false))
    expect(warns.some((w) => /plain-path copy of the hook wrapper could not be made/.test(w))).toBe(true)
    const out = new CodexProvider().buildSpawnCommand({ ...opts, realmLaunch: { ...launch, executable: 'C:\\npm\\codex.cmd' }, codexHooks: { hookFile } })
    expect(out.hooksInstalled).toBe(false)
    // A local app data folder whose path is not a plain word: said too.
    warns.length = 0
    __resetCodexHookFoldersForTests()
    __setCodexLocalAppDataForTests(join(lad, 'Riley Smith'))
    await new CodexProvider().prepareHookFolders(res, secureWith(true))
    expect(warns.some((w) => /is not a plain word/.test(w))).toBe(true)
  })
})

// Round 4 (P1, P2): the hook folders are prepared asynchronously (only while
// Codex is on, src/main/codex-hook-folders.ts); a launch uses them only once
// prepared, and a folder the rule cannot make this user's alone means no hooks.
describe('round 4: hook folders that are not ready, or not this user\'s alone, give no hooks, and say so', () => {
  it('a launch before any preparation starts without hooks, said', () => {
    resources(true)
    expect(new CodexProvider().prepareSessionHooks('sess-1', 51234, '0f8b6a2c-1d3e-4f50-9a61-7b2c3d4e5f60')).toBeNull()
    expect(warns.some((w) => /no hook folder for sess-1/.test(w))).toBe(true)
  })

  it('at the preparation and at a launch; once prepared, hooks and nothing said', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const res = resources(true)
    mkdirSync(join(res, 'codex-hooks'))
    expect(await new CodexProvider().prepareHookFolders(res, secureWith(false))).toBe(false)
    expect(warns.some((w) => /the hook folder in the data folder is not a real folder that this user alone owns/.test(w))).toBe(true)
    warns.length = 0
    expect(new CodexProvider().prepareSessionHooks('sess-1', 51234, '0f8b6a2c-1d3e-4f50-9a61-7b2c3d4e5f60')).toBeNull()
    expect(warns.some((w) => /no hook folder for sess-1/.test(w))).toBe(true)
    // Round 5 (G3): within the retry wait the failure is the answer, and nothing more is said.
    warns.length = 0
    expect(await new CodexProvider().prepareHookFolders(res, secureWith(true))).toBe(false)
    expect(warns).toEqual([])
    // Past it, made the user's: hooks, and nothing said.
    vi.setSystemTime(Date.now() + CODEX_HOOK_FOLDERS_RETRY_MS)
    expect(await new CodexProvider().prepareHookFolders(res, secureWith(true))).toBe(true)
    vi.useRealTimers()
    const h = new CodexProvider().prepareSessionHooks('sess-1', 51234, '0f8b6a2c-1d3e-4f50-9a61-7b2c3d4e5f60')
    expect(h).not.toBeNull()
    h?.dispose()
    expect(warns).toEqual([])
  })

  it('the deploy copies the scripts only: it makes no hook folder and prepares nothing', async () => {
    const res = resources(false)
    await new CodexProvider().deployResumePickerScript(res)
    expect(existsSync(join(res, 'codex-hooks'))).toBe(false)
    expect(new CodexProvider().prepareSessionHooks('sess-1', 51234, '0f8b6a2c-1d3e-4f50-9a61-7b2c3d4e5f60')).toBeNull()
  })
})

describe("the test's own log folder", () => {
  it("[host] the real logger keeps its log inside the test's own folder", async () => {
    const { getLogDir } = await import('../../../../src/main/debug-logger')
    expect(getLogDir()).toBe(join(TEST_DATA, 'debug'))
  })
})
