/**
 * ReplaySanitizer — the per-session log replay must preserve HISTORY: sequences
 * that destroy it live (alt-screen switches, screen/scrollback erases, full
 * resets) are stripped or turned into a visible divider. Found via /clear in an
 * alt-screen session rendering the whole replay blank (data was intact).
 */
import { describe, it, expect } from 'vitest'
import { ReplaySanitizer, CLEAR_DIVIDER } from '../../../src/renderer/lib/replay-sanitizer'

const ESC = '\x1b'

describe('ReplaySanitizer', () => {
  it('passes plain text and SGR colours through untouched', () => {
    const s = new ReplaySanitizer()
    const input = `hello ${ESC}[31mred${ESC}[0m world\r\n`
    expect(s.push(input)).toBe(input)
  })

  it('strips alt-screen enter/exit (1049, 1047, 1048, legacy 47)', () => {
    const s = new ReplaySanitizer()
    expect(s.push(`a${ESC}[?1049hb${ESC}[?1049lc`)).toBe('abc')
    expect(s.push(`${ESC}[?47h${ESC}[?1047h${ESC}[?1048hx`)).toBe('x')
  })

  it('turns a /clear (2J+3J+H) into ONE visible divider', () => {
    const s = new ReplaySanitizer()
    const out = s.push(`before${ESC}[2J${ESC}[3J${ESC}[Hafter`)
    expect(out).toBe(`before${CLEAR_DIVIDER}after`)
  })

  it('turns a full reset (ESC c) into the divider', () => {
    const s = new ReplaySanitizer()
    expect(s.push(`x${ESC}cy`)).toBe(`x${CLEAR_DIVIDER}y`)
  })

  it('keeps harmless erases (0J cursor-to-end, K line) untouched', () => {
    const s = new ReplaySanitizer()
    const input = `a${ESC}[0Jb${ESC}[Kc${ESC}[Jd`
    expect(s.push(input)).toBe(input)
  })

  it('handles an escape sequence SPLIT across two pushes', () => {
    const s = new ReplaySanitizer()
    const first = s.push(`abc${ESC}[?104`)
    const second = s.push('9hdef')
    expect(first + second).toBe('abcdef')
  })

  it('handles a split erase: divider still produced once', () => {
    const s = new ReplaySanitizer()
    const out = s.push(`x${ESC}[2`) + s.push(`J${ESC}[Hy`)
    expect(out).toBe(`x${CLEAR_DIVIDER}y`)
  })

  it('flush() releases a dangling partial escape at end-of-stream', () => {
    const s = new ReplaySanitizer()
    expect(s.push(`tail${ESC}[31`)).toBe('tail')
    expect(s.flush()).toBe(`${ESC}[31`)
  })
})
