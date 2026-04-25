import { describe, it, expect } from 'vitest'
import { stripCursorSequences } from '../../src/renderer/utils/terminalFormatting'

const ESC = '\x1b'

describe('stripCursorSequences', () => {
  describe('cursor control sequences', () => {
    it('passes both cursor SHOW (\\x1b[?25h) and cursor HIDE (\\x1b[?25l) through unchanged', () => {
      // Cursor visibility is left under TUI control; ConPTY +
      // alternate-screen rendering keep this faithful end-to-end.
      expect(stripCursorSequences(`${ESC}[?25hhello`)).toBe(`${ESC}[?25hhello`)
      expect(stripCursorSequences(`${ESC}[?25lhello`)).toBe(`${ESC}[?25lhello`)
    })

    it('strips cursor blink on/off', () => {
      expect(stripCursorSequences(`${ESC}[?12h`)).toBe('')
      expect(stripCursorSequences(`${ESC}[?12l`)).toBe('')
    })

    it('strips cursor style (DECSCUSR)', () => {
      expect(stripCursorSequences(`${ESC}[1 q`)).toBe('')
      expect(stripCursorSequences(`${ESC}[5 q`)).toBe('')
    })
  })

  describe('passthrough behaviour', () => {
    it('passes plain text and newlines unchanged', () => {
      expect(stripCursorSequences('plain text\nwith newlines')).toBe('plain text\nwith newlines')
    })

    it('preserves SGR reset (\\x1b[0m) and (\\x1b[m)', () => {
      expect(stripCursorSequences(`${ESC}[0m`)).toBe(`${ESC}[0m`)
      expect(stripCursorSequences(`${ESC}[m`)).toBe(`${ESC}[m`)
    })

    it('passes reverse-video, backgrounds, and foreground colours through (handled by ConPTY/xterm now)', () => {
      // Pre-ConPTY we used to scrub these defensively; with faithful
      // PTY hosting, xterm renders them as authored.
      expect(stripCursorSequences(`${ESC}[7m`)).toBe(`${ESC}[7m`)
      expect(stripCursorSequences(`${ESC}[1;7;43m`)).toBe(`${ESC}[1;7;43m`)
      expect(stripCursorSequences(`${ESC}[38;2;255;0;0;48;2;0;0;0m`)).toBe(`${ESC}[38;2;255;0;0;48;2;0;0;0m`)
    })

    it('passes spinner glyphs through (TUI repaint is faithful under ConPTY+alt-screen)', () => {
      expect(stripCursorSequences('✻ Honking…')).toBe('✻ Honking…')
      expect(stripCursorSequences('⠋⠙⠹')).toBe('⠋⠙⠹')
    })
  })
})
