import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock os and child_process so resolveCodexBinary is fully deterministic on CI.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, platform: vi.fn(() => 'linux') }
})
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    execSync: vi.fn(() => '/mock/path/codex\n'),
  }
})

// Mock setup-handlers so getResourcesDirectory returns a per-test value via the
// _mockResourcesDir state declared inside the useResumePicker describe below.
// Hoisted vi.mock requires the factory to access state via a getter pattern --
// we expose a global ref the test reads/writes from inside its describe.
vi.mock('../../../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => (globalThis as any).__mockResourcesDir ?? '',
}))

// U6: buildCodexSpawn reads the live conductor MCP port + secret to emit the
// per-spawn `-c` overrides. Drive them per-test via globals; default port 0
// (server not bound) so the existing tests see no MCP flags.
vi.mock('../../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => (globalThis as any).__mockMcpPort ?? 0,
  // GHSA-q83v: Codex's bearer token is now HMAC(secret, sessionId). Deterministic
  // session-specific stub so the assertions can pin THIS session's token.
  // A site that minted directly (skipping the provider record) gets a token no check expects.
  mcpSessionToken: () => 'tok-minted-directly',
  // Only the right provider gets the expected token: a wrong one fails the token checks.
  issueMcpSessionToken: (sessionId: string, provider: string) => ({ codex: `tok-${sessionId}` } as Record<string, string>)[provider] ?? 'tok-wrong-provider',
}))

vi.mock('../../../../src/main/providers/codex/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/providers/codex/telemetry')>()
  return { ...actual, watchAndClaimRollout: vi.fn(() => ({ stop: () => {} })) }
})

import * as osMod from 'os'
import { execSync } from 'child_process'
import { watchAndClaimRollout } from '../../../../src/main/providers/codex/telemetry'
import { CodexProvider } from '../../../../src/main/providers/codex'
import { resolveCodexBinary, resolveNodeExe, __resetNodeExeCache, codexCmdExeTarget } from '../../../../src/main/providers/codex/spawn'

// WP2 (plan A10): a Codex spawn runs only from its prepared realm launch -- the
// executable setup proved and the realm's environment. Main builds it; these
// tests hand one in.
const launch = { executable: '/mock/path/codex', env: { PATH: '/usr/bin', CODEX_HOME: '/res/codex-realms/r1' }, sessionsDir: '/res/codex-realms/r1/sessions' }
const winEnv = { SystemRoot: 'C:\\Windows', CODEX_HOME: 'C:\\res\\codex-realms\\r1' }

function withWin32<T>(fn: () => T): T {
  const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  try {
    return fn()
  } finally {
    if (origPlatform) Object.defineProperty(process, 'platform', origPlatform)
    else delete (process as any).platform
  }
}

describe('CodexProvider', () => {
  let originalCodexHome: string | undefined

  beforeEach(() => {
    originalCodexHome = process.env.CODEX_HOME
    // Default: linux, codex found at /mock/path/codex
    vi.mocked(osMod.platform).mockReturnValue('linux' as NodeJS.Platform)
    vi.mocked(execSync).mockReturnValue('/mock/path/codex\n' as any)
  })

  afterEach(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = originalCodexHome
    vi.clearAllMocks()
  })

  it('id and displayName are static', () => {
    const p = new CodexProvider()
    expect(p.id).toBe('codex')
    expect(p.displayName).toBe('Codex')
  })

  it('resolveCodexBinary (the discovery lookup) returns a cmd path when codex is found', () => {
    const r = resolveCodexBinary()
    expect(r).not.toBeNull()
    expect(r?.cmd).toMatch(/codex/i)
  })

  it('resolveBinary and resumeCommand refuse without looking anything up: a Codex launch runs only what its managed launch proved', () => {
    vi.mocked(execSync).mockClear()
    const p = new CodexProvider()
    expect(() => p.resolveBinary()).toThrow(/^resolveBinary is not used for Codex: launches go through the managed launch$/)
    expect(() => p.resumeCommand('abc')).toThrow(/^resumeCommand is not used for Codex: launches go through the managed launch$/)
    expect(execSync).not.toHaveBeenCalled()
  })

  it('resolveCodexBinary returns null when codex is not on PATH', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found') })
    const r = resolveCodexBinary()
    expect(r).toBeNull()
  })

  it('buildSpawnCommand refuses a spawn with no prepared realm launch (WP2): no second resolution, no ambient home', () => {
    expect(() => new CodexProvider().buildSpawnCommand({
      sessionId: 'sid',
      codexOptions: { model: 'gpt-5.5', reasoningEffort: 'medium', permissionsPreset: 'standard' },
    })).toThrow(/needs its account/)
    expect(vi.mocked(execSync)).not.toHaveBeenCalled()
  })

  it('buildSpawnCommand runs the executable the launch names, never re-resolving it', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('must not be consulted') })
    const out = new CodexProvider().buildSpawnCommand({
      sessionId: 'sid', realmLaunch: launch,
      codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' },
    })
    expect(out.cmd).toBe('/mock/path/codex')
  })

  it('buildSpawnCommand maps standard preset to workspace-write + on-request', () => {
    const out = new CodexProvider().buildSpawnCommand({
      sessionId: 'sid', realmLaunch: launch,
      codexOptions: { model: 'gpt-5.5', reasoningEffort: 'medium', permissionsPreset: 'standard' },
    })
    expect(out.args).toContain('--sandbox')
    expect(out.args).toContain('workspace-write')
    expect(out.args).toContain('--ask-for-approval')
    expect(out.args).toContain('on-request')
    expect(out.args).toContain('-c')
    expect(out.args).toContain('model_reasoning_effort=medium')
  })

  it('reasoningEffort=none suppresses the -c flag', () => {
    const out = new CodexProvider().buildSpawnCommand({
      sessionId: 'sid', realmLaunch: launch,
      codexOptions: { model: 'gpt-5.5', reasoningEffort: 'none', permissionsPreset: 'standard' },
    })
    expect(out.args.find(a => a.startsWith('model_reasoning_effort='))).toBeUndefined()
  })

  it('CODEX_HOME is the realm\'s, whatever the parent process carries (WP1.38)', () => {
    process.env.CODEX_HOME = '/tmp/codex-test'
    const out = new CodexProvider().buildSpawnCommand({
      sessionId: 'sid', realmLaunch: launch,
      codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' },
    })
    expect(out.env.CODEX_HOME).toBe('/res/codex-realms/r1')
  })

  it('CLAUDE_MULTI_SESSION_ID is set in env for telemetry hooks', () => {
    const out = new CodexProvider().buildSpawnCommand({
      sessionId: 'session-xyz', realmLaunch: launch,
      codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' },
    })
    expect(out.env.CLAUDE_MULTI_SESSION_ID).toBe('session-xyz')
  })

  // Book item 34: the host's light/dark scheme reached only the local Claude
  // spawn; Codex sessions never got COLORFGBG.
  describe('COLORFGBG (host light/dark scheme)', () => {
    const base = { sessionId: 'sid', realmLaunch: launch, codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' as const } }
    beforeEach(() => { delete process.env.COLORFGBG })
    afterEach(() => { delete process.env.COLORFGBG })
    it('stamps the light value when the host is light', () => {
      expect(new CodexProvider().buildSpawnCommand({ ...base, hostColorScheme: 'light' }).env.COLORFGBG).toBe('0;15')
    })
    it('stamps the dark value when the host is dark', () => {
      expect(new CodexProvider().buildSpawnCommand({ ...base, hostColorScheme: 'dark' }).env.COLORFGBG).toBe('15;0')
    })
    it('leaves it alone when the host scheme is unspecified', () => {
      expect(new CodexProvider().buildSpawnCommand(base).env.COLORFGBG).toBeUndefined()
    })
    it('is the SAME encoding the Claude spawn uses (one definition)', async () => {
      const { buildClaudeLocalSpawn } = await import('../../../../src/main/providers/claude/spawn')
      const claude = buildClaudeLocalSpawn({ sessionId: 'sid', cwd: '/w', cols: 80, rows: 24, hostColorScheme: 'light' }).env.COLORFGBG
      expect(new CodexProvider().buildSpawnCommand({ ...base, hostColorScheme: 'light' }).env.COLORFGBG).toBe(claude)
    })
  })

  it('injects per-spawn conductor MCP -c flags + bearer-token env when the MCP port is live (U6)', () => {
    ;(globalThis as any).__mockMcpPort = 19333
    try {
      const out = new CodexProvider().buildSpawnCommand({
        sessionId: 'sid', realmLaunch: launch,
        codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' },
      })
      // GHSA-q83v: cccSessionId is the sole query param; source=codex is inferred
      // from the /mcp route server-side, keeping the URL free of `&`.
      expect(out.args).toContain('mcp_servers.conductor.url=http://localhost:19333/mcp?cccSessionId=sid')
      expect(out.args).toContain('mcp_servers.conductor.enabled=true')
      expect(out.args).toContain('mcp_servers.conductor.bearer_token_env_var=CONDUCTOR_MCP_TOKEN')
      // WP2 5b: a Claude review may run 900 s plus its diff, launch and kill
      // settle; the pinned Codex gives a tool 300 s unless told otherwise.
      const timeoutFlag = out.args.find((a) => a.startsWith('mcp_servers.conductor.tool_timeout_sec='))
      expect(timeoutFlag).toBe('mcp_servers.conductor.tool_timeout_sec=1000.0')
      expect(Number(timeoutFlag!.split('=')[1])).toBeGreaterThan(900 + 30 + 15)
      // Token rides a bearer header via env -- NOT the URL -- and is this
      // session's per-session HMAC. The URL still has no `&`, so it survives the
      // cmd.exe .cmd-shim spawn path.
      expect(out.env.CONDUCTOR_MCP_TOKEN).toBe('tok-sid')
      const urlFlag = out.args.find((a) => a.startsWith('mcp_servers.conductor.url='))
      expect(urlFlag).not.toContain('&')
    } finally {
      delete (globalThis as any).__mockMcpPort
    }
  })

  it('omits the conductor MCP flags + token env when the MCP port is 0 (server not bound) (U6)', () => {
    ;(globalThis as any).__mockMcpPort = 0
    try {
      const out = new CodexProvider().buildSpawnCommand({
        sessionId: 'sid', realmLaunch: launch,
        codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' },
      })
      expect(out.args.find((a) => a.startsWith('mcp_servers.conductor'))).toBeUndefined()
      expect(out.env.CONDUCTOR_MCP_TOKEN).toBeUndefined()
    } finally {
      delete (globalThis as any).__mockMcpPort
    }
  })

  it('wraps a .cmd shim in cmd.exe named by absolute path -- AutoRun and delayed expansion off, the /s form, one verbatim line -- and stops cmd.exe searching the project folder', () => {
    withWin32(() => {
      const out = new CodexProvider().buildSpawnCommand({
        sessionId: 'sid', realmLaunch: { ...launch, executable: 'C:\\npm\\codex.cmd', env: winEnv },
        codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' },
      })
      expect(out.cmd).toBe('C:\\Windows\\System32\\cmd.exe')
      expect(out.args).toEqual([])
      expect(out.commandLine).toBe('/d /v:off /s /c ""C:\\npm\\codex.cmd" -m gpt-5.5 --sandbox workspace-write --ask-for-approval on-request"')
      expect(out.env.NoDefaultCurrentDirectoryInExePath).toBe('1')
    })
  })

  it('does not wrap an .exe in cmd.exe on win32', () => {
    withWin32(() => {
      const out = new CodexProvider().buildSpawnCommand({
        sessionId: 'sid', realmLaunch: { ...launch, executable: 'C:\\path\\codex.exe', env: winEnv },
        codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' },
      })
      expect(out.cmd).toBe('C:\\path\\codex.exe')
      expect(out.commandLine).toBeUndefined()
      expect(out.args[0]).toBe('-m')
    })
  })

  it('a variable main sets wins over every other spelling the parent passed (Windows names are case-insensitive)', () => {
    ;(globalThis as any).__mockMcpPort = 4321
    try {
      withWin32(() => {
        const env = { ...winEnv, conductor_mcp_token: 'ambient', claude_multi_session_id: 'other', ccc_codex_executable: 'C:\\evil\\codex.exe', nodefaultcurrentdirectoryinexepath: '0' }
        const out = new CodexProvider().buildSpawnCommand({
          sessionId: 'sid', realmLaunch: { ...launch, executable: 'C:\\npm\\codex.cmd', env },
          codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' },
        })
        const spellings = (name: string) => Object.keys(out.env).filter((k) => k.toUpperCase() === name.toUpperCase())
        for (const name of ['CONDUCTOR_MCP_TOKEN', 'CLAUDE_MULTI_SESSION_ID', 'NoDefaultCurrentDirectoryInExePath']) expect(spellings(name), name).toEqual([name])
        expect(out.env.CONDUCTOR_MCP_TOKEN).toBe('tok-sid')
        expect(out.env.CLAUDE_MULTI_SESSION_ID).toBe('sid')
      })
    } finally {
      delete (globalThis as any).__mockMcpPort
    }
  })

  it('on the picker route too: the executable handed over and the colour scheme exist in main\'s spelling only', () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = require('fs') as typeof import('fs')
    const { tmpdir } = require('os') as typeof import('os')
    const { join } = require('path') as typeof import('path')
    const dir = mkdtempSync(join(tmpdir(), 'ccc-spawn-owned-'))
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'scripts', 'codex-resume-picker.js'), '// stub')
    ;(globalThis as any).__mockResourcesDir = dir
    __resetNodeExeCache()
    vi.mocked(osMod.platform).mockReturnValue('win32' as NodeJS.Platform)
    vi.mocked(execSync).mockImplementation(() => 'C:\\nodejs\\node.exe\n' as any)
    try {
      withWin32(() => {
        const env = { ...winEnv, ccc_codex_executable: 'C:\\evil\\codex.exe', colorfgbg: '15;0' }
        const out = new CodexProvider().buildSpawnCommand({
          sessionId: 'sid', useResumePicker: true, hostColorScheme: 'light',
          realmLaunch: { ...launch, executable: 'C:\\npm\\codex.cmd', env },
          codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' },
        })
        const spellings = (name: string) => Object.keys(out.env).filter((k) => k.toUpperCase() === name.toUpperCase())
        expect(spellings('CCC_CODEX_EXECUTABLE')).toEqual(['CCC_CODEX_EXECUTABLE'])
        expect(out.env.CCC_CODEX_EXECUTABLE).toBe('C:\\npm\\codex.cmd')
        expect(spellings('COLORFGBG')).toEqual(['COLORFGBG'])
        expect(out.env.COLORFGBG).toBe('0;15')
      })
    } finally {
      delete (globalThis as any).__mockResourcesDir
      __resetNodeExeCache()
    }
  })

  describe('codexCmdExeTarget (the cmd.exe route)', () => {
    it('builds the /s line cli-runner builds for discovery, with the parent\'s own spelling of SystemRoot or ComSpec', () => {
      const line = '/d /v:off /s /c ""C:\\a\\codex.cmd" -m gpt-5.5"'
      expect(codexCmdExeTarget('C:\\a\\codex.cmd', ['-m', 'gpt-5.5'], winEnv)).toEqual({ cmd: 'C:\\Windows\\System32\\cmd.exe', commandLine: line })
      // Launched from Git Bash the parent spells them in capitals.
      expect(codexCmdExeTarget('C:\\a\\codex.cmd', ['-m', 'gpt-5.5'], { SYSTEMROOT: 'C:\\WINDOWS' }).cmd).toBe('C:\\WINDOWS\\System32\\cmd.exe')
      expect(codexCmdExeTarget('C:\\a\\codex.cmd', [], { COMSPEC: 'C:\\WINDOWS\\system32\\cmd.exe', SystemRoot: 'C:\\Windows' }).cmd).toBe('C:\\WINDOWS\\system32\\cmd.exe')
    })

    it('keeps a shim path with spaces and parentheses intact (the /s form strips only the outer pair of quotes)', () => {
      expect(codexCmdExeTarget('C:\\Program Files (x86)\\nodejs\\codex.cmd', ['--sandbox', 'read-only'], winEnv).commandLine)
        .toBe('/d /v:off /s /c ""C:\\Program Files (x86)\\nodejs\\codex.cmd" --sandbox read-only"')
      expect(codexCmdExeTarget('C:\\Users\\a@b c\\npm\\codex.cmd', [], winEnv).commandLine).toBe('/d /v:off /s /c ""C:\\Users\\a@b c\\npm\\codex.cmd""')
    })

    it('refuses a shim path or an argument cmd.exe or the shim would reinterpret, and a cmd.exe it cannot name absolutely', () => {
      for (const bad of ['"', '%', '&', '^', '|', '<', '>', '!', '(', ')', ' ', '\t', '\n']) {
        expect(() => codexCmdExeTarget('C:\\a\\codex.cmd', ['-m', `x${bad}y`], winEnv), JSON.stringify(bad)).toThrow(/cmd.exe/)
      }
      expect(() => codexCmdExeTarget('C:\\a\\codex.cmd', [''], winEnv)).toThrow(/cmd.exe/)
      for (const bad of ['"', '%', '&', '^', '\n']) {
        expect(() => codexCmdExeTarget(`C:\\a${bad}b\\codex.cmd`, [], winEnv), JSON.stringify(bad)).toThrow(/cmd.exe/)
      }
      for (const shim of ['codex.cmd', 'a\\codex.cmd', '\\a\\codex.cmd', 'C:a\\codex.cmd', 'C:\\a\\codex.cmd.', 'C:\\a\\codex.cmd ']) {
        expect(() => codexCmdExeTarget(shim, [], winEnv), shim).toThrow(/cmd.exe/)
      }
      for (const root of [undefined, '', 'Windows', 'C:Windows']) {
        expect(() => codexCmdExeTarget('C:\\a\\codex.cmd', [], { SystemRoot: root }), String(root)).toThrow(/SystemRoot/)
      }
      // Two spellings that disagree name no cmd.exe at all.
      expect(() => codexCmdExeTarget('C:\\a\\codex.cmd', [], { SystemRoot: 'C:\\Windows', SYSTEMROOT: 'D:\\Other' })).toThrow(/SystemRoot/)
    })

    it('a model id that passed the spawn schema can always pass cmd.exe (the schema is the tighter charset)', async () => {
      const { CODEX_MODEL_RE } = await import('../../../../src/main/sanitize-restored-spawn-options')
      for (const m of ['gpt-5.5', 'gpt-oss:20b', 'openai/gpt-5-codex', 'o4-mini']) {
        expect(CODEX_MODEL_RE.test(m), m).toBe(true)
        expect(() => codexCmdExeTarget('C:\\a\\codex.cmd', ['-m', m], winEnv), m).not.toThrow()
      }
      for (const m of ['-c', 'a&b', 'a b', 'x%y', '(x)', '']) expect(CODEX_MODEL_RE.test(m), m).toBe(false)
    })
  })

  describe('useResumePicker', () => {
    // The vi.mock at the top of this file points getResourcesDirectory at
    // globalThis.__mockResourcesDir. Toggle it per test via the helper below.
    function setMockResourcesDir(dir: string | null): void {
      ;(globalThis as any).__mockResourcesDir = dir ?? ''
    }

    beforeEach(() => {
      setMockResourcesDir(null)
    })

    afterEach(() => {
      delete (globalThis as any).__mockResourcesDir
    })

    beforeEach(() => {
      __resetNodeExeCache()
    })

    it('swaps cmd to node + picker when useResumePicker=true and script is deployed, handing it the proven executable', () => {
      const { mkdtempSync, mkdirSync, writeFileSync } = require('fs') as typeof import('fs')
      const { tmpdir } = require('os') as typeof import('os')
      const { join } = require('path') as typeof import('path')
      const dir = mkdtempSync(join(tmpdir(), 'ccc-spawn-test-'))
      mkdirSync(join(dir, 'scripts'), { recursive: true })
      writeFileSync(join(dir, 'scripts', 'codex-resume-picker.js'), '// stub')
      setMockResourcesDir(dir)

      // POSIX now resolves node via a login shell (a Finder/Dock-launched app
      // inherits launchd's minimal PATH, so bare 'node' can fail under PTY).
      vi.mocked(execSync).mockImplementation((cmd: any) => {
        const s = String(cmd)
        if (s.includes('which node')) return '/usr/local/bin/node\n' as any
        throw new Error(`unexpected: ${s}`)
      })

      const out = new CodexProvider().buildSpawnCommand({
        sessionId: 'sid-resume', realmLaunch: launch,
        useResumePicker: true,
        codexOptions: { model: 'gpt-5.5', reasoningEffort: 'xhigh', permissionsPreset: 'standard' },
      })

      // On win32 the full path comes from `where node`; on POSIX from the
      // login-shell `which node` probe (see resolveNodeExe).
      expect(out.cmd).toBe('/usr/local/bin/node')
      expect(out.args[0]).toBe(join(dir, 'scripts', 'codex-resume-picker.js'))
      expect(out.args).toContain('-m')
      expect(out.args).toContain('gpt-5.5')
      expect(out.args).toContain('--sandbox')
      expect(out.args).toContain('workspace-write')
      expect(out.args).toContain('--ask-for-approval')
      expect(out.args).toContain('on-request')
      // The picker starts THIS executable, in THIS realm.
      expect(out.env.CCC_CODEX_EXECUTABLE).toBe('/mock/path/codex')
      expect(out.env.CODEX_HOME).toBe('/res/codex-realms/r1')
    })

    it('falls back to direct codex spawn when useResumePicker=true but picker script is missing', () => {
      const { mkdtempSync } = require('fs') as typeof import('fs')
      const { tmpdir } = require('os') as typeof import('os')
      const { join } = require('path') as typeof import('path')
      const dir = mkdtempSync(join(tmpdir(), 'ccc-spawn-fallback-'))
      // Intentionally do NOT create scripts/codex-resume-picker.js in `dir`
      setMockResourcesDir(dir)

      const out = new CodexProvider().buildSpawnCommand({
        sessionId: 'sid-fallback', realmLaunch: launch,
        useResumePicker: true,
        codexOptions: { model: 'gpt-5.5', reasoningEffort: 'xhigh', permissionsPreset: 'standard' },
      })

      // cmd is the codex binary path (not 'node'), and the first arg is NOT the picker script
      expect(out.cmd).toBe('/mock/path/codex')
      expect(out.args).toContain('-m')
      expect(out.args).toContain('gpt-5.5')
      // CLAUDE_MULTI_SESSION_ID env must survive the fallback path so downstream
      // hook / telemetry correlation stays correct (per spec Architecture step 1).
      expect(out.env.CLAUDE_MULTI_SESSION_ID).toBe('sid-fallback')
    })

    it('useResumePicker=false leaves cmd as direct codex spawn', () => {
      setMockResourcesDir('')
      const out = new CodexProvider().buildSpawnCommand({
        sessionId: 'sid-no-picker', realmLaunch: launch,
        useResumePicker: false,
        codexOptions: { model: 'gpt-5.5', reasoningEffort: 'medium', permissionsPreset: 'standard' },
      })
      expect(out.cmd).toBe('/mock/path/codex')
      expect(out.env.CCC_CODEX_EXECUTABLE).toBeUndefined()
    })

    // Regression for #347: node-pty/ConPTY on Windows does NOT consult PATH
    // for bare names -- pty.spawn('node', ...) throws "File not found:"
    // synchronously before any onExit/onData fires, so the renderer attaches
    // xterm to a dead PTY (blank-terminal symptom). Fix is to resolve node
    // via `where node` and pass the full path. Non-win32 stays bare 'node'
    // because execvp does PATH lookup.
    it('win32 picker spawn resolves node to a full .exe path (not bare "node"), and never looks codex up', () => {
      const { mkdtempSync, mkdirSync, writeFileSync } = require('fs') as typeof import('fs')
      const { tmpdir } = require('os') as typeof import('os')
      const { join } = require('path') as typeof import('path')
      const dir = mkdtempSync(join(tmpdir(), 'ccc-spawn-win32-picker-'))
      mkdirSync(join(dir, 'scripts'), { recursive: true })
      writeFileSync(join(dir, 'scripts', 'codex-resume-picker.js'), '// noop')
      setMockResourcesDir(dir)

      vi.mocked(osMod.platform).mockReturnValue('win32' as NodeJS.Platform)
      vi.mocked(execSync).mockImplementation((cmd: any) => {
        const s = String(cmd)
        if (s.includes('where node')) return 'C:\\Program Files\\nodejs\\node.exe\n' as any
        throw new Error(`unexpected: ${s}`)
      })

      const out = withWin32(() => new CodexProvider().buildSpawnCommand({
        sessionId: 'sid-win32-picker', realmLaunch: { ...launch, executable: 'C:\\npm\\codex.cmd', env: winEnv },
        useResumePicker: true,
        codexOptions: { model: 'gpt-5.5', reasoningEffort: 'medium', permissionsPreset: 'standard' },
      }))

      expect(out.cmd).toBe('C:\\Program Files\\nodejs\\node.exe')
      expect(out.cmd).not.toBe('node')
      expect(out.args[0]).toBe(join(dir, 'scripts', 'codex-resume-picker.js'))
      expect(out.env.CCC_CODEX_EXECUTABLE).toBe('C:\\npm\\codex.cmd')
    })

    it('the picker route refuses what the cmd.exe route would (a .cmd shim with an unsafe path)', () => {
      const { mkdtempSync, mkdirSync, writeFileSync } = require('fs') as typeof import('fs')
      const { tmpdir } = require('os') as typeof import('os')
      const { join } = require('path') as typeof import('path')
      const dir = mkdtempSync(join(tmpdir(), 'ccc-spawn-win32-picker-bad-'))
      mkdirSync(join(dir, 'scripts'), { recursive: true })
      writeFileSync(join(dir, 'scripts', 'codex-resume-picker.js'), '// noop')
      setMockResourcesDir(dir)
      expect(() => withWin32(() => new CodexProvider().buildSpawnCommand({
        sessionId: 'sid-bad', realmLaunch: { ...launch, executable: 'C:\\a%b\\codex.cmd', env: winEnv },
        useResumePicker: true,
        codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' },
      }))).toThrow(/cmd.exe/)
    })

    it('resolveNodeExe falls back to bare "node" on win32 if `where node` fails', () => {
      vi.mocked(osMod.platform).mockReturnValue('win32' as NodeJS.Platform)
      vi.mocked(execSync).mockImplementation(() => { throw new Error('not found') })
      expect(resolveNodeExe()).toBe('node')
    })

    it('resolveNodeExe resolves node via a login shell on non-win32 (launchd minimal-PATH hazard)', () => {
      vi.mocked(osMod.platform).mockReturnValue('linux' as NodeJS.Platform)
      vi.mocked(execSync).mockImplementation((cmd: any) => {
        const s = String(cmd)
        if (s.includes('-l -c') && s.includes('which node')) return '/opt/homebrew/bin/node\n' as any
        throw new Error(`unexpected: ${s}`)
      })
      expect(resolveNodeExe()).toBe('/opt/homebrew/bin/node')
    })

    it('resolveNodeExe falls back to bare "node" on non-win32 when the login-shell probe fails', () => {
      vi.mocked(osMod.platform).mockReturnValue('linux' as NodeJS.Platform)
      vi.mocked(execSync).mockImplementation(() => { throw new Error('not found') })
      expect(resolveNodeExe()).toBe('node')
    })
  })
})

describe('CodexProvider telemetry (WP2 plan A13)', () => {
  it('watches the session\'s own realm folder, and nothing without one: the ambient home would claim another account\'s transcript', () => {
    vi.mocked(watchAndClaimRollout).mockClear()
    const none = new CodexProvider().ingestSessionTelemetry('sid', { cwd: '/w', spawnTimestamp: 1 }, () => {})
    expect(() => none.stop()).not.toThrow()
    expect(vi.mocked(watchAndClaimRollout)).not.toHaveBeenCalled()
    const cb = () => {}
    new CodexProvider().ingestSessionTelemetry('sid', { cwd: '/w', spawnTimestamp: 7, sessionsDir: '/res/codex-realms/r1/sessions' }, cb)
    expect(vi.mocked(watchAndClaimRollout)).toHaveBeenCalledWith('sid', '/w', 7, cb, '/res/codex-realms/r1/sessions')
  })
})
