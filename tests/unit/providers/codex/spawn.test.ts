import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { CodexProvider } from '../../../../src/main/providers/codex'

describe('CodexProvider', () => {
  let originalCodexHome: string | undefined
  beforeEach(() => { originalCodexHome = process.env.CODEX_HOME })
  afterEach(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = originalCodexHome
  })

  it('id and displayName are static', () => {
    const p = new CodexProvider()
    expect(p.id).toBe('codex')
    expect(p.displayName).toBe('Codex')
  })

  it('resolveBinary returns null when codex not on PATH (or a real path on dev box)', () => {
    const r = new CodexProvider().resolveBinary()
    if (r) expect(r.cmd).toMatch(/codex/i)
    // else null is fine (CI box without codex installed)
  })

  it('buildSpawnCommand throws when resolveBinary returns null and codex not installed', () => {
    // skip on dev boxes where codex is installed -- the throw path can't be exercised reliably
    const p = new CodexProvider()
    if (p.resolveBinary() != null) return  // codex installed, skip
    expect(() => p.buildSpawnCommand({
      sessionId: 'sid',
      codexOptions: { model: 'gpt-5.5', reasoningEffort: 'medium', permissionsPreset: 'standard' },
    })).toThrow(/Codex CLI not found/)
  })

  it('buildSpawnCommand maps standard preset to workspace-write + on-request', () => {
    const p = new CodexProvider()
    if (p.resolveBinary() == null) return  // codex not installed, skip
    const out = p.buildSpawnCommand({
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
    const p = new CodexProvider()
    if (p.resolveBinary() == null) return
    const out = p.buildSpawnCommand({
      sessionId: 'sid',
      codexOptions: { model: 'gpt-5.5', reasoningEffort: 'none', permissionsPreset: 'standard' },
    })
    expect(out.args.find(a => a.startsWith('model_reasoning_effort='))).toBeUndefined()
  })

  it('passes CODEX_HOME through env when set externally', () => {
    const p = new CodexProvider()
    if (p.resolveBinary() == null) return
    process.env.CODEX_HOME = '/tmp/codex-test'
    const out = p.buildSpawnCommand({
      sessionId: 'sid',
      codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' },
    })
    expect(out.env.CODEX_HOME).toBe('/tmp/codex-test')
  })

  it('CLAUDE_MULTI_SESSION_ID is set in env for telemetry hooks', () => {
    const p = new CodexProvider()
    if (p.resolveBinary() == null) return
    const out = p.buildSpawnCommand({
      sessionId: 'session-xyz',
      codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' },
    })
    expect(out.env.CLAUDE_MULTI_SESSION_ID).toBe('session-xyz')
  })
})
