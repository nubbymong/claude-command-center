import { describe, it, expect } from 'vitest'
import { stripCursorSequences } from '../../src/renderer/utils/terminalFormatting'

const ESC = '\x1b'

describe('stripCursorSequences', () => {
  describe('cursor control sequences', () => {
    it('strips cursor SHOW (\\x1b[?25h) but keeps cursor HIDE (\\x1b[?25l)', () => {
      expect(stripCursorSequences(`${ESC}[?25hhello`)).toBe('hello')
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

  describe('reverse video', () => {
    it('strips standalone reverse video', () => {
      expect(stripCursorSequences(`${ESC}[7m`)).toBe('')
      expect(stripCursorSequences(`${ESC}[27m`)).toBe('')
    })

    it('strips reverse video from compound SGR while keeping siblings', () => {
      // bold + reverse → bold only
      expect(stripCursorSequences(`${ESC}[1;7m`)).toBe(`${ESC}[1m`)
      // reverse + foreground yellow → foreground yellow only
      expect(stripCursorSequences(`${ESC}[7;33m`)).toBe(`${ESC}[33m`)
      // reverse + truecolor FG → truecolor FG preserved
      expect(stripCursorSequences(`${ESC}[7;38;2;255;0;0m`)).toBe(`${ESC}[38;2;255;0;0m`)
    })
  })

  describe('background-color stripping', () => {
    it('strips standalone 8-color bg (40-47)', () => {
      for (let n = 40; n <= 47; n++) {
        expect(stripCursorSequences(`${ESC}[${n}mtext`)).toBe('text')
      }
    })

    it('strips standalone bright bg (100-107)', () => {
      for (let n = 100; n <= 107; n++) {
        expect(stripCursorSequences(`${ESC}[${n}mtext`)).toBe('text')
      }
    })

    it('strips standalone 256-color bg (48;5;N)', () => {
      expect(stripCursorSequences(`${ESC}[48;5;226m`)).toBe('')   // bright yellow
      expect(stripCursorSequences(`${ESC}[48;5;3m`)).toBe('')     // dim yellow
      expect(stripCursorSequences(`${ESC}[48;5;215mtext`)).toBe('text')
    })

    it('strips standalone truecolor bg (48;2;R;G;B)', () => {
      expect(stripCursorSequences(`${ESC}[48;2;255;255;0m`)).toBe('')
      expect(stripCursorSequences(`${ESC}[48;2;200;120;50mtext`)).toBe('text')
    })
  })

  describe('compound SGR — the bug the v1.4 nuclear strip was supposed to kill', () => {
    it('strips bg from FG+BG combined truecolor', () => {
      // FG red + BG black truecolor → FG red only
      const input = `${ESC}[38;2;255;0;0;48;2;0;0;0m`
      expect(stripCursorSequences(input)).toBe(`${ESC}[38;2;255;0;0m`)
    })

    it('strips bg from bold+bg shorthand', () => {
      // bold + yellow bg → bold only
      expect(stripCursorSequences(`${ESC}[1;43m`)).toBe(`${ESC}[1m`)
    })

    it('strips bg from bold+reverse+bg combined', () => {
      // bold + reverse + yellow bg → bold only
      expect(stripCursorSequences(`${ESC}[1;7;43m`)).toBe(`${ESC}[1m`)
    })

    it('strips bg from FG+bold+256-bg compound', () => {
      // FG yellow + bold + 256-color bg → FG yellow + bold
      expect(stripCursorSequences(`${ESC}[33;1;48;5;226m`)).toBe(`${ESC}[33;1m`)
    })

    it('strips multiple bg sequences in the same SGR (rare but possible)', () => {
      // duplicate 48;2;... back-to-back
      expect(stripCursorSequences(`${ESC}[48;2;255;0;0;48;2;0;255;0m`)).toBe('')
    })

    it('preserves foreground 38;2; and 38;5; sequences', () => {
      // FG truecolor only
      expect(stripCursorSequences(`${ESC}[38;2;255;128;0m`)).toBe(`${ESC}[38;2;255;128;0m`)
      // FG 256
      expect(stripCursorSequences(`${ESC}[38;5;220m`)).toBe(`${ESC}[38;5;220m`)
    })

    it('does not match foreground 8-color (30-37) or bright FG (90-97)', () => {
      expect(stripCursorSequences(`${ESC}[33m`)).toBe(`${ESC}[33m`)
      expect(stripCursorSequences(`${ESC}[93m`)).toBe(`${ESC}[93m`)
    })
  })

  describe('passthrough behaviour', () => {
    it('passes through non-SGR text unchanged', () => {
      expect(stripCursorSequences('plain text\nwith newlines')).toBe('plain text\nwith newlines')
    })

    it('preserves SGR reset (\\x1b[0m) and (\\x1b[m)', () => {
      expect(stripCursorSequences(`${ESC}[0m`)).toBe(`${ESC}[0m`)
      expect(stripCursorSequences(`${ESC}[m`)).toBe(`${ESC}[m`)
    })
  })
})
