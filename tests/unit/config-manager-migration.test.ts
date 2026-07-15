import { describe, it, expect } from 'vitest'
import type { TerminalConfig } from '../../src/renderer/stores/configStore'
import { migrateConfigToProviderShape } from '../../src/main/config-manager'

describe('TerminalConfig schema', () => {
  it('requires provider field', () => {
    const cfg: TerminalConfig = {
      id: 'c1', label: 'X', color: '#fff', workingDirectory: '/tmp', sessionType: 'local',
      provider: 'claude', claudeOptions: { model: 'sonnet' },
    }
    expect(cfg.provider).toBe('claude')
  })

  it('rejects shape without provider (TS-level)', () => {
    // @ts-expect-error provider is required
    const _bad: TerminalConfig = { id: 'c2', label: 'X', color: '#fff', workingDirectory: '/tmp', sessionType: 'local' }
    void _bad
  })
})

describe('migrateConfigToProviderShape', () => {
  it('back-fills provider=claude on legacy entries', () => {
    const legacy = {
      id: 'c1', label: 'X', color: '#fff', workingDirectory: '/tmp', sessionType: 'local',
      model: 'sonnet', effortLevel: 'medium', disableAutoMemory: true, agentIds: ['a-1'],
    }
    const out = migrateConfigToProviderShape(legacy)
    expect(out.provider).toBe('claude')
    expect(out.claudeOptions).toEqual({ model: 'sonnet', effortLevel: 'medium', disableAutoMemory: true, agentIds: ['a-1'] })
    expect((out as any).model).toBeUndefined()
    expect((out as any).effortLevel).toBeUndefined()
    expect((out as any).disableAutoMemory).toBeUndefined()
    expect((out as any).agentIds).toBeUndefined()
  })

  it('leaves new-shape entries equal by value (idempotent)', () => {
    const newShape = {
      id: 'c2', label: 'X', color: '#fff', workingDirectory: '/tmp', sessionType: 'local',
      provider: 'claude', claudeOptions: { model: 'sonnet' },
    }
    const out = migrateConfigToProviderShape(newShape as any)
    expect(out).toEqual(newShape)
  })

  it('handles partial overlap (provider set, legacy fields linger)', () => {
    const partial = {
      id: 'c3', label: 'X', color: '#fff', workingDirectory: '/tmp', sessionType: 'local',
      provider: 'claude', model: 'sonnet',
    }
    const out = migrateConfigToProviderShape(partial as any)
    expect(out.claudeOptions?.model).toBe('sonnet')
    expect((out as any).model).toBeUndefined()
  })

  it('claudeOptions wins over legacy field on conflict', () => {
    const conflict = {
      id: 'c4', label: 'X', color: '#fff', workingDirectory: '/tmp', sessionType: 'local',
      provider: 'claude', model: 'sonnet', claudeOptions: { model: 'opus' },
    }
    const out = migrateConfigToProviderShape(conflict as any)
    expect(out.claudeOptions?.model).toBe('opus')
  })

  it('sets empty claudeOptions when no legacy fields present', () => {
    const minimal = {
      id: 'c5', label: 'X', color: '#fff', workingDirectory: '/tmp', sessionType: 'local',
    }
    const out = migrateConfigToProviderShape(minimal)
    expect(out.provider).toBe('claude')
    expect(out.claudeOptions).toEqual({})
  })

  // P7.7.19: codex config carrying stale legacy Claude fields must converge.
  // The earlier helper only stripped legacy fields on provider==='claude' but
  // migrateConfigsToProviderShape's dirty check fires whenever any legacy
  // field is present, so codex configs with stale fields rewrote configs.json
  // on every boot without ever converging. The fix is to strip the legacy
  // fields regardless of provider; legacy fields on a codex config are
  // orphan cruft (Codex reads codexOptions only).
  it('strips legacy Claude fields from codex configs (does NOT copy to claudeOptions)', () => {
    const codexWithStaleClaude = {
      id: 'c6', label: 'X', color: '#fff', workingDirectory: '/tmp', sessionType: 'local' as const,
      provider: 'codex' as const,
      codexOptions: { model: 'gpt-5.5', reasoningEffort: 'medium' as const, permissionsPreset: 'standard' as const },
      // Stale legacy Claude fields (e.g. from a UI flow that converted Claude -> Codex)
      model: 'sonnet',
      effortLevel: 'high',
      disableAutoMemory: true,
    }
    const out = migrateConfigToProviderShape(codexWithStaleClaude as any)
    expect(out.provider).toBe('codex')
    expect(out.codexOptions).toEqual({ model: 'gpt-5.5', reasoningEffort: 'medium', permissionsPreset: 'standard' })
    // Critical: legacy fields stripped, NOT copied into claudeOptions
    expect((out as any).model).toBeUndefined()
    expect((out as any).effortLevel).toBeUndefined()
    expect((out as any).disableAutoMemory).toBeUndefined()
    expect((out as any).claudeOptions).toBeUndefined()
  })

  it('codex config converges (second migration is byte-equal to first)', () => {
    const codexWithStaleClaude = {
      id: 'c7', label: 'X', color: '#fff', workingDirectory: '/tmp', sessionType: 'local' as const,
      provider: 'codex' as const,
      codexOptions: { model: 'gpt-5.5', reasoningEffort: 'medium' as const, permissionsPreset: 'standard' as const },
      model: 'sonnet', // stale
    }
    const pass1 = migrateConfigToProviderShape(codexWithStaleClaude as any)
    const pass2 = migrateConfigToProviderShape(pass1)
    expect(pass2).toEqual(pass1)
    // And the legacy field really is gone after pass1 (so dirty check stops firing)
    expect((pass1 as any).model).toBeUndefined()
  })
})
