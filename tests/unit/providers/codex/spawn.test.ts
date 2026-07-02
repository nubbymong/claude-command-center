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
  getConductorMcpSecret: () => 'test-secret-123',
}))

import * as osMod from 'os'
import { execSync } from 'child_process'
import { CodexProvider } from '../../../../src/main/providers/codex'
import { resolveCodexBinary, resolveNodeExe, __resetNodeExeCache } from '../../../../src/main/providers/codex/spawn'

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

  it('resolveBinary returns a cmd path when codex is found', () => {
    const r = new CodexProvider().resolveBinary()
    expect(r).not.toBeNull()
    expect(r?.cmd).toMatch(/codex/i)
  })

  it('resolveBinary returns null when codex is not on PATH', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found') })
    const r = resolveCodexBinary()
    expect(r).toBeNull()
  })

  it('buildSpawnCommand throws when codex not found', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found') })
    expect(() => new CodexProvider().buildSpawnCommand({
      sessionId: 'sid',
      codexOptions: { model: 'gpt-5.5', reasoningEffort: 'medium', permissionsPreset: 'standard' },
    })).toThrow(/Codex CLI not found/)
  })

  it('buildSpawnCommand maps standard preset to workspace-write + on-request', () => {
    const out = new CodexProvider().buildSpawnCommand({
      sessionId: 'sid',
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
      sessionId: 'sid',
      codexOptions: { model: 'gpt-5.5', reasoningEffort: 'none', permissionsPreset: 'standard' },
    })
    expect(out.args.find(a => a.startsWith('model_reasoning_effort='))).toBeUndefined()
  })

  it('passes CODEX_HOME through env when set externally', () => {
    process.env.CODEX_HOME = '/tmp/codex-test'
    const out = new CodexProvider().buildSpawnCommand({
      sessionId: 'sid',
      codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' },
    })
    expect(out.env.CODEX_HOME).toBe('/tmp/codex-test')
  })

  it('CLAUDE_MULTI_SESSION_ID is set in env for telemetry hooks', () => {
    const out = new CodexProvider().buildSpawnCommand({
      sessionId: 'session-xyz',
      codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' },
    })
    expect(out.env.CLAUDE_MULTI_SESSION_ID).toBe('session-xyz')
  })

  it('injects per-spawn conductor MCP -c flags + bearer-token env when the MCP port is live (U6)', () => {
    ;(globalThis as any).__mockMcpPort = 19333
    try {
      const out = new CodexProvider().buildSpawnCommand({
        sessionId: 'sid',
        codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' },
      })
      expect(out.args).toContain('mcp_servers.conductor.url=http://localhost:19333/mcp?source=codex')
      expect(out.args).toContain('mcp_servers.conductor.enabled=true')
      expect(out.args).toContain('mcp_servers.conductor.bearer_token_env_var=CONDUCTOR_MCP_TOKEN')
      // Token rides a bearer header via env -- NOT the URL -- so the URL has no
      // `&` and survives the cmd.exe .cmd-shim spawn path.
      expect(out.env.CONDUCTOR_MCP_TOKEN).toBe('test-secret-123')
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
        sessionId: 'sid',
        codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' },
      })
      expect(out.args.find((a) => a.startsWith('mcp_servers.conductor'))).toBeUndefined()
      expect(out.env.CONDUCTOR_MCP_TOKEN).toBeUndefined()
    } finally {
      delete (globalThis as any).__mockMcpPort
    }
  })

  it('wraps .cmd binary in cmd.exe /c on win32 for node-pty', () => {
    // Simulate win32: where finds codex.cmd
    vi.mocked(osMod.platform).mockReturnValue('win32' as NodeJS.Platform)
    vi.mocked(execSync).mockReturnValue('C:\\npm\\codex.cmd\n' as any)
    // process.platform check in buildCodexSpawn; stub it for this test
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const out = new CodexProvider().buildSpawnCommand({
        sessionId: 'sid',
        codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' },
      })
      expect(out.cmd).toBe('cmd.exe')
      expect(out.args[0]).toBe('/c')
      expect(out.args[1]).toBe('C:\\npm\\codex.cmd')
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform)
      else delete (process as any).platform
    }
  })

  it('does not wrap .exe binary in cmd.exe on win32', () => {
    vi.mocked(osMod.platform).mockReturnValue('win32' as NodeJS.Platform)
    vi.mocked(execSync).mockReturnValue('C:\\path\\codex.exe\n' as any)
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const out = new CodexProvider().buildSpawnCommand({
        sessionId: 'sid',
        codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' },
      })
      expect(out.cmd).toBe('C:\\path\\codex.exe')
      expect(out.args[0]).not.toBe('/c')
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform)
      else delete (process as any).platform
    }
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

    it('swaps cmd to node + picker when useResumePicker=true and script is deployed', () => {
      const { mkdtempSync, mkdirSync, writeFileSync } = require('fs') as typeof import('fs')
      const { tmpdir } = require('os') as typeof import('os')
      const { join } = require('path') as typeof import('path')
      const dir = mkdtempSync(join(tmpdir(), 'ccc-spawn-test-'))
      mkdirSync(join(dir, 'scripts'), { recursive: true })
      writeFileSync(join(dir, 'scripts', 'codex-resume-picker.js'), '// stub')
      setMockResourcesDir(dir)

      const out = new CodexProvider().buildSpawnCommand({
        sessionId: 'sid-resume',
        useResumePicker: true,
        codexOptions: { model: 'gpt-5.5', reasoningEffort: 'xhigh', permissionsPreset: 'standard' },
      })

      // On linux/macOS bare 'node' works (PTY uses execvp -> PATH lookup).
      // On win32 we resolve the full path via `where node` (see resolveNodeExe).
      expect(out.cmd).toBe('node')
      expect(out.args[0]).toBe(join(dir, 'scripts', 'codex-resume-picker.js'))
      expect(out.args).toContain('-m')
      expect(out.args).toContain('gpt-5.5')
      expect(out.args).toContain('--sandbox')
      expect(out.args).toContain('workspace-write')
      expect(out.args).toContain('--ask-for-approval')
      expect(out.args).toContain('on-request')
    })

    it('falls back to direct codex spawn when useResumePicker=true but picker script is missing', () => {
      const { mkdtempSync } = require('fs') as typeof import('fs')
      const { tmpdir } = require('os') as typeof import('os')
      const { join } = require('path') as typeof import('path')
      const dir = mkdtempSync(join(tmpdir(), 'ccc-spawn-fallback-'))
      // Intentionally do NOT create scripts/codex-resume-picker.js in `dir`
      setMockResourcesDir(dir)

      const out = new CodexProvider().buildSpawnCommand({
        sessionId: 'sid-fallback',
        useResumePicker: true,
        codexOptions: { model: 'gpt-5.5', reasoningEffort: 'xhigh', permissionsPreset: 'standard' },
      })

      // cmd is the codex binary path (not 'node'), and the first arg is NOT the picker script
      expect(out.cmd).not.toBe('node')
      expect(out.cmd).toMatch(/codex/i)
      expect(out.args).toContain('-m')
      expect(out.args).toContain('gpt-5.5')
      // CLAUDE_MULTI_SESSION_ID env must survive the fallback path so downstream
      // hook / telemetry correlation stays correct (per spec Architecture step 1).
      expect(out.env.CLAUDE_MULTI_SESSION_ID).toBe('sid-fallback')
    })

    it('useResumePicker=false leaves cmd as direct codex spawn', () => {
      setMockResourcesDir('')
      const out = new CodexProvider().buildSpawnCommand({
        sessionId: 'sid-no-picker',
        useResumePicker: false,
        codexOptions: { model: 'gpt-5.5', reasoningEffort: 'medium', permissionsPreset: 'standard' },
      })
      expect(out.cmd).not.toBe('node')
      expect(out.cmd).toMatch(/codex/i)
    })

    // Regression for #347: node-pty/ConPTY on Windows does NOT consult PATH
    // for bare names -- pty.spawn('node', ...) throws "File not found:"
    // synchronously before any onExit/onData fires, so the renderer attaches
    // xterm to a dead PTY (blank-terminal symptom). Fix is to resolve node
    // via `where node` and pass the full path. Non-win32 stays bare 'node'
    // because execvp does PATH lookup.
    it('win32 picker spawn resolves node to a full .exe path (not bare "node")', () => {
      const { mkdtempSync, mkdirSync, writeFileSync } = require('fs') as typeof import('fs')
      const { tmpdir } = require('os') as typeof import('os')
      const { join } = require('path') as typeof import('path')
      const dir = mkdtempSync(join(tmpdir(), 'ccc-spawn-win32-picker-'))
      mkdirSync(join(dir, 'scripts'), { recursive: true })
      writeFileSync(join(dir, 'scripts', 'codex-resume-picker.js'), '// noop')
      setMockResourcesDir(dir)

      // Simulate win32 + where finding codex.cmd + node.exe at specific paths.
      // execSync is consulted twice (once for codex, once for node); return
      // different paths per call.
      vi.mocked(osMod.platform).mockReturnValue('win32' as NodeJS.Platform)
      vi.mocked(execSync).mockImplementation((cmd: any) => {
        const s = String(cmd)
        if (s.includes('where node')) return 'C:\\Program Files\\nodejs\\node.exe\n' as any
        if (s.includes('where codex')) return 'C:\\npm\\codex.cmd\n' as any
        throw new Error(`unexpected: ${s}`)
      })

      const out = new CodexProvider().buildSpawnCommand({
        sessionId: 'sid-win32-picker',
        useResumePicker: true,
        codexOptions: { model: 'gpt-5.5', reasoningEffort: 'medium', permissionsPreset: 'standard' },
      })

      expect(out.cmd).toBe('C:\\Program Files\\nodejs\\node.exe')
      expect(out.cmd).not.toBe('node')
      expect(out.args[0]).toBe(join(dir, 'scripts', 'codex-resume-picker.js'))
    })

    it('resolveNodeExe falls back to bare "node" on win32 if `where node` fails', () => {
      vi.mocked(osMod.platform).mockReturnValue('win32' as NodeJS.Platform)
      vi.mocked(execSync).mockImplementation(() => { throw new Error('not found') })
      expect(resolveNodeExe()).toBe('node')
    })

    it('resolveNodeExe returns bare "node" on non-win32 without invoking where', () => {
      vi.mocked(osMod.platform).mockReturnValue('linux' as NodeJS.Platform)
      const before = vi.mocked(execSync).mock.calls.length
      expect(resolveNodeExe()).toBe('node')
      expect(vi.mocked(execSync).mock.calls.length).toBe(before)
    })
  })
})
