import { describe, it, expect } from 'vitest'
import { stripCursorSequences, formatDuration } from '../../src/renderer/utils/terminalFormatting'

const ESC = '\x1b'

describe('formatDuration', () => {
  const SEC = 1000
  const MIN = 60 * SEC
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR

  it('shows seconds under a minute', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(5 * SEC)).toBe('5s')
    expect(formatDuration(59 * SEC)).toBe('59s')
  })
  it('shows minutes + seconds under an hour', () => {
    expect(formatDuration(MIN)).toBe('1m 0s')
    expect(formatDuration(2 * MIN + 38 * SEC)).toBe('2m 38s')
    expect(formatDuration(59 * MIN + 59 * SEC)).toBe('59m 59s')
  })
  it('rolls up to hours + minutes at/over 60 minutes', () => {
    expect(formatDuration(HOUR)).toBe('1h 0m')
    expect(formatDuration(HOUR + 30 * MIN)).toBe('1h 30m')
    expect(formatDuration(23 * HOUR + 59 * MIN)).toBe('23h 59m')
  })
  it('rolls up to days + hours at/over 24 hours', () => {
    expect(formatDuration(DAY)).toBe('1d 0h')
    expect(formatDuration(DAY + 4 * HOUR)).toBe('1d 4h')
    // The original report: 1731m 38s -> 28h 51m -> 1d 4h.
    expect(formatDuration(1731 * MIN + 38 * SEC)).toBe('1d 4h')
  })
  it('clamps negative input to 0s', () => {
    expect(formatDuration(-5000)).toBe('0s')
  })
})

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
