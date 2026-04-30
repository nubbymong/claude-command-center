import { describe, it, expect } from 'vitest'
import type { TerminalConfig } from '../../src/renderer/stores/configStore'

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
