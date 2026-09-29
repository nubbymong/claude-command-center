// P3.10 (rows 43, 46, 47, 63): a Codex launch carries the app's hooks when main
// hands it a hook file (the Hooks gateway on and listening), as a Claude launch
// carries its http hooks in its settings file: the same command for every
// session (Codex's trust of a reviewed hook lasts while it is unchanged), the
// session named by the environment the hook inherits (its id, and the hook
// file's path; never the token). None without a hook file, before the
// forwarder is deployed, or when the command cannot be given safely on the
// launch's route.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs'
import { join, basename, dirname } from 'path'
import { tmpdir } from 'os'

vi.mock('../../../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => (globalThis as any).__mockResourcesDir ?? '',
}))
vi.mock('../../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  mcpSessionToken: () => 'tok',
  issueMcpSessionToken: () => 'tok',
}))

import { CodexProvider } from '../../../../src/main/providers/codex'
import { codexHookCommand, codexHookConfigArgs, CODEX_HOOK_FILE_ENV } from '../../../../src/main/providers/codex/hooks'
import { codexCmdExeTarget } from '../../../../src/main/providers/codex/spawn'

const TEST_PREFIX = 'p310-spawn-hooks-'
const made: string[] = []
function resources(deploy = true): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), TEST_PREFIX)))
  made.push(d)
  mkdirSync(join(d, 'scripts'))
  if (deploy) {
    writeFileSync(join(d, 'scripts', 'ccc-codex-hook.js'), '// test copy')
    writeFileSync(join(d, 'scripts', 'ccc-codex-hook.cmd'), 'rem test copy')
  }
  ;(globalThis as any).__mockResourcesDir = d
  return d
}
afterEach(() => {
  ;(globalThis as any).__mockResourcesDir = undefined
  // TEST CLEANUP GUARD: only the folders this test made, by their own prefix, under the temp folder.
  for (const d of made.splice(0)) {
    if (!basename(d).startsWith(TEST_PREFIX) || dirname(d) !== realpathSync.native(tmpdir())) continue
    rmSync(d, { recursive: true, force: true })
  }
})

const exe = process.platform === 'win32' ? 'C:\\codex\\codex.exe' : '/opt/codex/bin/codex'
const launch = { executable: exe, env: { PATH: process.platform === 'win32' ? 'C:\\Windows' : '/usr/bin', CODEX_HOME: '/res/r1', SystemRoot: 'C:\\Windows' }, sessionsDir: '/res/r1/sessions' }
const hookFile = join(tmpdir(), 'ccc-codex-hook-abc', 'hook.json')
const opts = { sessionId: 'sess-1', realmLaunch: launch, codexOptions: { permissionsPreset: 'standard' as const } }

function hookArgs(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) if (args[i] === '-c' && /^hooks\./.test(args[i + 1] ?? '')) out.push(args[i + 1])
  return out
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

  it('the resume picker and an exact resume forward the same hooks', () => {
    resources()
    const direct = new CodexProvider().buildSpawnCommand({ ...opts, codexHooks: { hookFile } })
    const picker = new CodexProvider().buildSpawnCommand({ ...opts, useResumePicker: true, codexHooks: { hookFile } })
    expect(hookArgs(picker.args)).toEqual(hookArgs(direct.args))
    expect(picker.hooksInstalled).toBe(true)
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
