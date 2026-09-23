// WP1.54 / WP1.68 Gate 0 characterization of the CURRENT Codex singleton
// behaviour on the pre-change base (gaps C2, C3, C4, C9 in
// docs/wp1/baseline-2026-09-19.md). These pin observable inputs/outputs so the
// retirement of the singleton auth IPC, the global-home resolvers and the
// write-only spawn identity map is provably deliberate. They describe what the
// base does; they do not endorse it. Two assertions below are scheduled to be
// INVERTED by WP1 and are marked as such (see the baseline record): C3's
// "CODEX_HOME is never set" (inverted by WP1.38) and C4's "the API key
// travels as an ordinary IPC payload field" (inverted by WP1.22). The file is
// retired with the code it characterizes (ledger, WP1.57 / WP1.58).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, platform: vi.fn(() => 'linux') }
})
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execSync: vi.fn(() => '/mock/path/codex\n') }
})
vi.mock('../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '' }))
vi.mock('../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => (globalThis as any).__wp1McpPort ?? 0,
  mcpSessionToken: (sid: string) => `tok-${sid}`,
}))
vi.mock('../../src/main/config-manager', () => ({ readConfig: () => ({ conductorToolsEnabled: true }) }))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const handlers = new Map<string, (...a: any[]) => any>()
vi.mock('electron', () => ({ ipcMain: { handle: (ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn) } }))
const auth = vi.hoisted(() => ({
  readCodexAuthStatus: vi.fn(async (..._a: unknown[]) => ({ installed: true, version: '0.0.0', authMode: 'none', hasOpenAiApiKeyEnv: false })),
  codexLoginWithApiKey: vi.fn(async (_k: string) => ({ ok: true })),
  codexLoginChatgpt: vi.fn(async () => ({ ok: true, browserUrl: 'https://example.test/chatgpt' })),
  codexLoginDeviceAuth: vi.fn(async () => ({ ok: true, deviceCode: 'DEVCODE1' })),
  codexLogout: vi.fn(async () => ({ ok: false })),
  codexTestConnection: vi.fn(async () => ({ ok: true, message: 'Logged in' })),
}))
vi.mock('../../src/main/providers/codex/auth', () => auth)

import * as osMod from 'os'
import { execSync } from 'child_process'
import { IPC } from '../../src/shared/ipc-channels'
import { CodexProvider } from '../../src/main/providers/codex'
import { buildCodexSpawn } from '../../src/main/providers/codex/spawn'
import { registerCodexHandlers } from '../../src/main/ipc/codex-handlers'

const ROOT = resolve(__dirname, '..', '..')
const codexOptions = { model: 'gpt-5.5', reasoningEffort: 'medium', permissionsPreset: 'standard' } as const

// The launch FLAGS (-m, model_reasoning_effort, --sandbox, --ask-for-approval)
// are pinned by tests/unit/providers/codex/spawn.test.ts; C3 pins the
// environment and the per-spawn MCP wiring only.
describe('C3: Codex spawn environment on the base', () => {
  let savedHome: string | undefined
  beforeEach(() => {
    savedHome = process.env.CODEX_HOME
    vi.mocked(osMod.platform).mockReturnValue('linux' as NodeJS.Platform)
    vi.mocked(execSync).mockReturnValue('/mock/path/codex\n' as any)
    ;(globalThis as any).__wp1McpPort = 0
  })
  afterEach(() => {
    if (savedHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = savedHome
    delete process.env.WP1_SENTINEL
  })

  it('spreads the parent process environment and stamps CLAUDE_MULTI_SESSION_ID', () => {
    process.env.WP1_SENTINEL = 'inherited'
    const out = buildCodexSpawn({ sessionId: 's1', codexOptions })
    expect(out.env.WP1_SENTINEL).toBe('inherited')
    expect(out.env.CLAUDE_MULTI_SESSION_ID).toBe('s1')
  })

  it('[to be inverted by WP1.38] never sets CODEX_HOME itself: absent stays absent, an inherited value passes through unchanged', () => {
    delete process.env.CODEX_HOME
    expect(buildCodexSpawn({ sessionId: 's1', codexOptions }).env.CODEX_HOME).toBeUndefined()
    process.env.CODEX_HOME = '/inherited/home'
    expect(buildCodexSpawn({ sessionId: 's1', codexOptions }).env.CODEX_HOME).toBe('/inherited/home')
  })

  it('adds the conductor MCP flags and bearer token only when the MCP port is bound (WP1.68 per-spawn MCP)', () => {
    const off = buildCodexSpawn({ sessionId: 's2', codexOptions })
    expect(off.args.join(' ')).not.toContain('mcp_servers.conductor')
    expect(off.env.CONDUCTOR_MCP_TOKEN).toBeUndefined()
    ;(globalThis as any).__wp1McpPort = 4321
    const on = buildCodexSpawn({ sessionId: 's2', codexOptions })
    expect(on.args).toContain('mcp_servers.conductor.url=http://localhost:4321/mcp?cccSessionId=s2')
    expect(on.args).toContain('mcp_servers.conductor.enabled=true')
    expect(on.args).toContain('mcp_servers.conductor.bearer_token_env_var=CONDUCTOR_MCP_TOKEN')
    expect(on.env.CONDUCTOR_MCP_TOKEN).toBe('tok-s2')
  })

  it('routes a Windows .cmd shim through cmd.exe /c', () => {
    vi.mocked(osMod.platform).mockReturnValue('win32' as NodeJS.Platform)
    vi.mocked(execSync).mockReturnValue('C:\\shims\\codex.cmd\r\n' as any)
    const saved = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const out = buildCodexSpawn({ sessionId: 's3', codexOptions })
      expect(out.cmd).toBe('cmd.exe')
      expect(out.args.slice(0, 2)).toEqual(['/c', 'C:\\shims\\codex.cmd'])
    } finally {
      Object.defineProperty(process, 'platform', saved)
    }
  })
})

describe('C2: CodexProvider class contract on the base', () => {
  beforeEach(() => {
    vi.mocked(osMod.platform).mockReturnValue('linux' as NodeJS.Platform)
    vi.mocked(execSync).mockReturnValue('/mock/path/codex\n' as any)
  })
  it('listHistorySessions is an empty stub and configureMcpServer is a no-op', async () => {
    const p = new CodexProvider()
    expect(p.id).toBe('codex')
    expect(p.displayName).toBe('Codex')
    await expect(p.listHistorySessions()).resolves.toEqual([])
    await expect(p.configureMcpServer({ name: 'conductor', url: 'http://localhost:1/mcp' })).resolves.toBeUndefined()
  })
  it('resumeCommand is `codex resume <id>` on the resolved binary and throws when codex is missing', () => {
    const p = new CodexProvider()
    expect(p.resumeCommand('abc')).toEqual({ cmd: '/mock/path/codex', args: ['resume', 'abc'] })
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found') })
    expect(() => p.resumeCommand('abc')).toThrow(/not found on PATH/)
  })
  it('detectUiRunning recognises the Codex TUI escape sequence and not a plain prompt (WP1.68 TUI detection)', () => {
    const p = new CodexProvider()
    expect(p.detectUiRunning('$ ')).toBe(false)
    expect(p.detectUiRunning('\x1b[?2026h\x1b[?1004h')).toBe(true)
  })
})

describe('C4: registerCodexHandlers dispatch on the base (singleton, implicit global home)', () => {
  const invoke = (ch: string, ...args: any[]) => handlers.get(ch)!({} as any, ...args)
  beforeEach(() => { handlers.clear(); vi.clearAllMocks(); registerCodexHandlers() })

  it('registers exactly the four singleton channels', () => {
    expect([...handlers.keys()].sort()).toEqual([IPC.CODEX_LOGIN, IPC.CODEX_LOGOUT, IPC.CODEX_STATUS, IPC.CODEX_TEST_CONNECTION].sort())
  })
  it('status resolves the implicit global home (no realm argument) and returns the status object', async () => {
    const r = await invoke(IPC.CODEX_STATUS)
    expect(auth.readCodexAuthStatus).toHaveBeenCalledTimes(1)
    expect(auth.readCodexAuthStatus.mock.calls[0]).toEqual([])
    expect(r).toEqual({ installed: true, version: '0.0.0', authMode: 'none', hasOpenAiApiKeyEnv: false })
  })
  it('rejects a malformed login payload with a structured error and calls no login', async () => {
    for (const bad of [undefined, null, {}, { mode: 'magic' }, { mode: 'api-key', apiKey: '' }, { mode: 'api-key', apiKey: 'k'.repeat(501) }]) {
      const r = await invoke(IPC.CODEX_LOGIN, bad)
      expect(r.ok).toBe(false)
      expect(String(r.error)).toMatch(/Invalid parameters/)
    }
    expect(auth.codexLoginWithApiKey).not.toHaveBeenCalled()
    expect(auth.codexLoginChatgpt).not.toHaveBeenCalled()
    expect(auth.codexLoginDeviceAuth).not.toHaveBeenCalled()
  })
  it('[to be inverted by WP1.22] api-key mode requires apiKey and receives it as an ordinary IPC payload field', async () => {
    expect(await invoke(IPC.CODEX_LOGIN, { mode: 'api-key' })).toEqual({ ok: false, error: 'apiKey required' })
    expect(auth.codexLoginWithApiKey).not.toHaveBeenCalled()
    expect(await invoke(IPC.CODEX_LOGIN, { mode: 'api-key', apiKey: 'sk-test-characterization' })).toEqual({ ok: true })
    expect(auth.codexLoginWithApiKey).toHaveBeenCalledWith('sk-test-characterization')
    expect(auth.codexLoginChatgpt).not.toHaveBeenCalled()
    expect(auth.codexLoginDeviceAuth).not.toHaveBeenCalled()
  })
  it('chatgpt mode dispatches only to the ChatGPT login and returns its result', async () => {
    expect(await invoke(IPC.CODEX_LOGIN, { mode: 'chatgpt' })).toEqual({ ok: true, browserUrl: 'https://example.test/chatgpt' })
    expect(auth.codexLoginChatgpt).toHaveBeenCalledTimes(1)
    expect(auth.codexLoginDeviceAuth).not.toHaveBeenCalled()
    expect(auth.codexLoginWithApiKey).not.toHaveBeenCalled()
  })
  it('device mode dispatches only to the device login and returns its result', async () => {
    expect(await invoke(IPC.CODEX_LOGIN, { mode: 'device' })).toEqual({ ok: true, deviceCode: 'DEVCODE1' })
    expect(auth.codexLoginDeviceAuth).toHaveBeenCalledTimes(1)
    expect(auth.codexLoginChatgpt).not.toHaveBeenCalled()
    expect(auth.codexLoginWithApiKey).not.toHaveBeenCalled()
  })
  it('logout and testConnection delegate and return the delegate result unchanged', async () => {
    expect(await invoke(IPC.CODEX_LOGOUT)).toEqual({ ok: false })
    expect(await invoke(IPC.CODEX_TEST_CONNECTION)).toEqual({ ok: true, message: 'Logged in' })
    expect(auth.codexLogout).toHaveBeenCalledTimes(1)
    expect(auth.codexTestConnection).toHaveBeenCalledTimes(1)
  })
})

describe('C9: the Codex spawn identity map is write-only on the base (proof for its deletion, WP1.57)', () => {
  const grep = (pattern: string) => {
    try {
      return execFileSync('git', ['-C', ROOT, 'grep', '-n', '-E', pattern, '--', 'src'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    } catch (e: any) {
      if (e.status === 1) return [] // no match
      throw e
    }
  }
  it('getCodexSpawnIdentityMap has no production reader beyond its definition and the pty-manager re-export', () => {
    const hits = grep('getCodexSpawnIdentityMap').filter((l) => !/^src\/main\/codex-spawn-identity\.ts:/.test(l))
    expect(hits.every((l) => /^src\/main\/pty-manager\.ts:\d+:.*(import|export)/.test(l)), hits.join('\n')).toBe(true)
    expect(hits.some((l) => /getCodexSpawnIdentityMap\(/.test(l))).toBe(false)
  })
  it('readCodexAccountEmail is consumed only by the spawn identity module', () => {
    const hits = grep('readCodexAccountEmail\\(').filter((l) => !/^src\/main\/account-identity\.ts:/.test(l))
    expect([...new Set(hits.map((l) => l.split(':')[0]))]).toEqual(['src/main/codex-spawn-identity.ts'])
  })
})
