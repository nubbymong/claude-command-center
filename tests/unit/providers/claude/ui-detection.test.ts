import { describe, it, expect } from 'vitest'
import { detectClaudeUi, lastPromptLineForClaude } from '../../../../src/main/providers/claude/ui-detection'

describe('Claude UI detection', () => {
  describe('detectClaudeUi', () => {
    it('matches strict box-drawing rules at any phase', () => {
      expect(detectClaudeUi('╭───────────────╮', false)).toBe(true)
    })
    it('does not match short box drawing pre-claudeSent (powerline-like)', () => {
      expect(detectClaudeUi('╭──╮', false)).toBe(false)
    })
    it('matches lenient markers only after claudeSent', () => {
      expect(detectClaudeUi('❯ hello', true)).toBe(true)
      expect(detectClaudeUi('❯ hello', false)).toBe(false)
    })
    it('matches vertical bars + glyphs after claudeSent', () => {
      expect(detectClaudeUi('│ some output', true)).toBe(true)
    })
  })

  describe('lastPromptLineForClaude', () => {
    it('extracts last shell prompt line', () => {
      const result = lastPromptLineForClaude('some output\nuser@host:~$ ')
      expect(result).toMatch(/\$/)
    })
    it('excludes lines containing ❯', () => {
      expect(lastPromptLineForClaude('❯ \n')).toBe('')
    })
    it('strips ANSI escape sequences', () => {
      const ansi = '\x1b[32muser@host\x1b[0m:~$ '
      expect(lastPromptLineForClaude(ansi)).toBe('user@host:~$')
    })
    it('returns empty for very long lines (>= 200 chars)', () => {
      expect(lastPromptLineForClaude('x'.repeat(201))).toBe('')
    })
  })
})
