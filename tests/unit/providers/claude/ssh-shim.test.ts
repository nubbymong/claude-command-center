import { describe, it, expect } from 'vitest'
import { ClaudeProvider } from '../../../../src/main/providers/claude'

describe('ClaudeProvider SSH-capable surface', () => {
  it('configureRemoteSettings produces a base64-piped node command', () => {
    const p = new ClaudeProvider()
    const cmd = p.configureRemoteSettings('sid-x', '~/repo', null)
    expect(cmd).toContain('base64 -d | node')
    expect(cmd).toContain('cd ~/repo')
  })

  it('getSshSettingsPath returns ~/.claude/settings-<safeSid>.json', () => {
    const p = new ClaudeProvider()
    expect(p.getSshSettingsPath('sid-1')).toBe('~/.claude/settings-sid-1.json')
  })

  it('sanitizes session id in settings path', () => {
    const p = new ClaudeProvider()
    expect(p.getSshSettingsPath('sid/with*bad:chars')).toBe('~/.claude/settings-sid_with_bad_chars.json')
  })
})
