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

import * as osMod from 'os'
import { execSync } from 'child_process'
import { CodexProvider } from '../../../../src/main/providers/codex'
import { resolveCodexBinary } from '../../../../src/main/providers/codex/spawn'

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
})
