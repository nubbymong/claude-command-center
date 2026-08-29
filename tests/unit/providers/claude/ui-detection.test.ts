import { describe, it, expect } from 'vitest'
import { detectClaudeUi, lastPromptLineForClaude, looksLikeShellPromptTail } from '../../../../src/main/providers/claude/ui-detection'

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

  // #25: the idle-fallback uses this to avoid latching claude-running when
  // claude actually exited to a bare shell.
  describe('looksLikeShellPromptTail', () => {
    it('detects a bare shell prompt (claude exited)', () => {
      expect(looksLikeShellPromptTail('[adm-severson@p-aai-se01 ~]$ ')).toBe(true)
      expect(looksLikeShellPromptTail('some output\nuser@host:/tmp# ')).toBe(true)
    })
    it('detects a shell prompt through ANSI/OSC noise and trailing blank lines', () => {
      expect(looksLikeShellPromptTail('\x1b[0m\x1b]0;title\x07[user@host ~]$ \n\n')).toBe(true)
    })
    it('never flags a RUNNING claude (❯ / box drawing) as exited', () => {
      expect(looksLikeShellPromptTail('╭─────────╮\n│ ❯ type here            │\n╰─────────╯')).toBe(false)
      expect(looksLikeShellPromptTail('❯ ')).toBe(false)
      // Even if a $ appears earlier, the LAST line is the claude input.
      expect(looksLikeShellPromptTail('cost: $0.12\n❯ ')).toBe(false)
    })
    it('excludes > and ~ endings (a claude screen can end in either)', () => {
      expect(looksLikeShellPromptTail('foo >')).toBe(false)
      expect(looksLikeShellPromptTail('~')).toBe(false)
    })
    it('is false on empty / no prompt', () => {
      expect(looksLikeShellPromptTail('')).toBe(false)
      expect(looksLikeShellPromptTail('just some text')).toBe(false)
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

    // The Windows-OpenSSH regression (probed against a real host, 2026-08-27):
    // ConPTY appends the window-title OSC to the SAME line as the prompt, and
    // the old CSI-only strip left it in place — so the visible line no longer
    // END-anchored on "password:" / "$" and the saved password was never typed
    // (the idle fallback then advanced the flow past the waiting prompt).
    it('strips the ConPTY title OSC glued to a real Windows-OpenSSH password prompt', () => {
      const chunk = "\x1b[?25lpi@192.168.50.201's password: \x1b]0;C:\\Windows\\System32\\OpenSSH\\ssh.exe\x07\x1b[?25h"
      expect(lastPromptLineForClaude(chunk)).toBe("pi@192.168.50.201's password:")
      expect(/password[:?]\s*$/i.test(lastPromptLineForClaude(chunk))).toBe(true)
    })
    it('strips private-mode CSI (\\x1b[?25l — the old [0-9;] class missed the ?)', () => {
      expect(lastPromptLineForClaude('\x1b[?25luser@host:~$ \x1b[?25h')).toBe('user@host:~$')
    })
    it('strips a title OSC after a real post-login shell prompt (BEL-terminated)', () => {
      const chunk = '\x1b[32m\x1b[1mpi@mongminer\x1b[m:\x1b[34m\x1b[1m~ $\x1b[m \x1b]0;pi@mongminer: ~\x07'
      expect(lastPromptLineForClaude(chunk)).toBe('pi@mongminer:~ $')
      expect(/[$#>~]\s*$/.test(lastPromptLineForClaude(chunk))).toBe(true)
    })
    it('strips an ST-terminated OSC too', () => {
      expect(lastPromptLineForClaude('user@host:~$ \x1b]0;title\x1b\\')).toBe('user@host:~$')
    })
    it('drops a TRAILING unterminated escape (title OSC split across chunks)', () => {
      expect(lastPromptLineForClaude("pi@host's password: \x1b]0;C:\\Wind")).toBe("pi@host's password:")
      expect(lastPromptLineForClaude('user@host:~$ \x1b')).toBe('user@host:~$')
    })
  })
})
