import { describe, it, expect } from 'vitest'
import { ClaudeProvider } from '../../../../src/main/providers/claude'
import type { HistorySession } from '../../../../src/main/providers/types'

describe('ClaudeProvider resume + history', () => {
  it('listHistorySessions returns array of HistorySession with provider=claude', async () => {
    const p = new ClaudeProvider()
    const sessions: HistorySession[] = await p.listHistorySessions()
    expect(Array.isArray(sessions)).toBe(true)
    if (sessions.length > 0) {
      const s = sessions[0]
      expect(s.provider).toBe('claude')
      expect(typeof s.sessionId).toBe('string')
      expect(s.sessionId.length).toBeGreaterThan(0)
      expect(typeof s.lastModified).toBe('number')
      expect(typeof s.cwd).toBe('string')
      // cwd must be a real path — not an encoded project-dir name like "F--CLAUDE-MULTI-APP"
      // Real paths contain a path separator (/ or \) or are a drive root like "F:"
      expect(s.cwd).toMatch(/[/\\]|^[A-Za-z]:$/)
      expect(typeof s.label).toBe('string')
    }
  })

  it('resumeCommand returns claude --resume <id>', () => {
    const p = new ClaudeProvider()
    const r = p.resumeCommand('test-session-id')
    expect(typeof r.cmd).toBe('string')
    expect(r.cmd.length).toBeGreaterThan(0)
    expect(r.args).toEqual(['--resume', 'test-session-id'])
  })
})
