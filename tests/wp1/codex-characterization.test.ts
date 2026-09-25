// WP1.54 / WP1.68 Gate 0 characterization of the CURRENT Codex singleton
// behaviour on the pre-change base (gaps C2, C3, C4, C9 in
// docs/wp1/baseline-2026-09-19.md). These pin observable inputs/outputs so the
// retirement of the singleton auth IPC, the global-home resolvers and the
// write-only spawn identity map is provably deliberate. They describe what the
// base does; they do not endorse it. C3's "CODEX_HOME is never set" was
// INVERTED by WP1.38 (WP2 commit 4) and is marked as such, and so was C2's
// "resumeCommand runs the codex found on PATH" (WP2 final fixes: a Codex
// launch runs only the executable its managed launch proved).
//
// C4 (the codex:* auth IPC dispatch, whose "the API key travels as an ordinary
// IPC payload field" WP1.22 inverted) and C9 (the write-only spawn identity
// map) were retired with the code they characterized in WP2 commit 6g
// (ledger, WP1.57 / WP1.58): that code is deleted, and its absence is pinned
// by tests/wp1/legacy-codex-retired.test.ts. What remains here characterizes
// code that is still in use.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

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
  // A site that minted directly (skipping the provider record) gets a token no check expects.
  mcpSessionToken: () => 'tok-minted-directly',
  // Only the right provider gets the expected token: a wrong one fails the token checks.
  issueMcpSessionToken: (sid: string, provider: string) => ({ codex: `tok-${sid}` } as Record<string, string>)[provider] ?? 'tok-wrong-provider',
}))
vi.mock('../../src/main/config-manager', () => ({ readConfig: () => ({ conductorToolsEnabled: true }) }))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

import * as osMod from 'os'
import { execSync } from 'child_process'
import { CodexProvider } from '../../src/main/providers/codex'
import { buildCodexSpawn } from '../../src/main/providers/codex/spawn'

const codexOptions = { model: 'gpt-5.5', reasoningEffort: 'medium', permissionsPreset: 'standard' } as const

// The launch FLAGS (-m, model_reasoning_effort, --sandbox, --ask-for-approval)
// are pinned by tests/unit/providers/codex/spawn.test.ts; C3 pins the
// environment and the per-spawn MCP wiring only.
//
// INVERTED by WP1.38 (WP2 commit 4): the base spread the parent environment
// and never set CODEX_HOME. A Codex spawn now runs only from its prepared
// realm launch: the realm's environment (ambient credentials removed,
// CODEX_HOME set by the launch) and the executable setup proved.
const realmLaunch = {
  executable: '/proven/bin/codex',
  env: { PATH: '/usr/bin', HOME: '/home/u', CODEX_HOME: '/res/codex-realms/r1' },
  sessionsDir: '/res/codex-realms/r1/sessions',
}
describe('C3: Codex spawn environment (inverted by WP1.38)', () => {
  let savedHome: string | undefined
  beforeEach(() => {
    savedHome = process.env.CODEX_HOME
    vi.mocked(osMod.platform).mockReturnValue('linux' as NodeJS.Platform)
    vi.mocked(execSync).mockClear()
    vi.mocked(execSync).mockReturnValue('/mock/path/codex\n' as any)
    ;(globalThis as any).__wp1McpPort = 0
  })
  afterEach(() => {
    if (savedHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = savedHome
    delete process.env.WP1_SENTINEL
    delete process.env.OPENAI_API_KEY
  })

  it('refuses a spawn with no prepared realm launch: there is no other way to start Codex', () => {
    expect(() => buildCodexSpawn({ sessionId: 's0', codexOptions })).toThrow(/needs its account/)
  })

  it('[inverted by WP1.38] starts from the realm environment, never the parent: an ambient CODEX_HOME or key does not pass', () => {
    process.env.WP1_SENTINEL = 'inherited'
    process.env.CODEX_HOME = '/inherited/home'
    process.env.OPENAI_API_KEY = 'sk-ambient'
    const out = buildCodexSpawn({ sessionId: 's1', codexOptions, realmLaunch })
    expect(out.env.CODEX_HOME).toBe('/res/codex-realms/r1')
    expect(out.env.WP1_SENTINEL).toBeUndefined()
    expect(out.env.OPENAI_API_KEY).toBeUndefined()
    expect(out.env.CLAUDE_MULTI_SESSION_ID).toBe('s1')
    expect(out.env.PATH).toBe('/usr/bin')
  })

  it('runs the executable setup proved, never a second resolution', () => {
    const out = buildCodexSpawn({ sessionId: 's1', codexOptions, realmLaunch })
    expect(out.cmd).toBe('/proven/bin/codex')
    expect(vi.mocked(execSync)).not.toHaveBeenCalled()
  })

  it('adds the conductor MCP flags and bearer token only when the MCP port is bound (WP1.68 per-spawn MCP)', () => {
    const off = buildCodexSpawn({ sessionId: 's2', codexOptions, realmLaunch })
    expect(off.args.join(' ')).not.toContain('mcp_servers.conductor')
    expect(off.env.CONDUCTOR_MCP_TOKEN).toBeUndefined()
    ;(globalThis as any).__wp1McpPort = 4321
    const on = buildCodexSpawn({ sessionId: 's2', codexOptions, realmLaunch })
    expect(on.args).toContain('mcp_servers.conductor.url=http://localhost:4321/mcp?cccSessionId=s2')
    expect(on.args).toContain('mcp_servers.conductor.enabled=true')
    expect(on.args).toContain('mcp_servers.conductor.bearer_token_env_var=CONDUCTOR_MCP_TOKEN')
    expect(on.env.CONDUCTOR_MCP_TOKEN).toBe('tok-s2')
  })

  it('routes a Windows .cmd shim through cmd.exe named by absolute path, AutoRun and delayed expansion off, in the /s form, and never searches the project folder', () => {
    const saved = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const winLaunch = { executable: 'C:\\shims\\codex.cmd', env: { SystemRoot: 'C:\\Windows', CODEX_HOME: 'C:\\res\\codex-realms\\r1' }, sessionsDir: 'C:\\res\\codex-realms\\r1\\sessions' }
      const out = buildCodexSpawn({ sessionId: 's3', codexOptions, realmLaunch: winLaunch })
      expect(out.cmd).toBe('C:\\Windows\\System32\\cmd.exe')
      expect(out.commandLine?.startsWith('/d /v:off /s /c ""C:\\shims\\codex.cmd" ')).toBe(true)
      expect(out.env.NoDefaultCurrentDirectoryInExePath).toBe('1')
      // A value cmd.exe would reinterpret is refused, not quoted.
      expect(() => buildCodexSpawn({ sessionId: 's3', codexOptions, realmLaunch: { ...winLaunch, executable: 'C:\\a%PATH%\\codex.cmd' } })).toThrow(/cmd.exe/)
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
  // INVERTED (WP2 final fixes): on the base this was `codex resume <id>` on
  // the codex found on PATH. Nothing called it; a Codex launch now runs only
  // the executable its managed launch proved, so it refuses and looks
  // nothing up, found or not.
  it('INVERTED: resumeCommand refuses and never resolves the codex on PATH', () => {
    vi.mocked(execSync).mockClear()
    const p = new CodexProvider()
    expect(() => p.resumeCommand('abc')).toThrow(/not used for Codex: launches go through the managed launch/)
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found') })
    expect(() => p.resumeCommand('abc')).toThrow(/not used for Codex: launches go through the managed launch/)
    expect(execSync).not.toHaveBeenCalled()
  })
  it('detectUiRunning recognises the Codex TUI escape sequence and not a plain prompt (WP1.68 TUI detection)', () => {
    const p = new CodexProvider()
    expect(p.detectUiRunning('$ ')).toBe(false)
    expect(p.detectUiRunning('\x1b[?2026h\x1b[?1004h')).toBe(true)
  })
})
