import { describe, it, expect } from 'vitest'
import { stripAnsi } from '../../../src/main/logging/ansi-strip'

describe('stripAnsi', () => {
  it('removes CSI/SGR sequences, keeps text + newlines', () => {
    expect(stripAnsi('a\x1b[31mb\x1b[0m\nc')).toBe('ab\nc')
  })
  it('removes OSC sequences (e.g. window title)', () => {
    expect(stripAnsi('\x1b]0;title\x07x')).toBe('x')      // BEL-terminated
    expect(stripAnsi('\x1b]0;title\x1b\\y')).toBe('y')     // ST-terminated
  })
  it('keeps tabs and newlines, strips lone ESC controls', () => {
    expect(stripAnsi('col1\tcol2\nrow2')).toBe('col1\tcol2\nrow2')
  })
  it('removes cursor-move CSI sequences', () => {
    expect(stripAnsi('\x1b[2Jscreen cleared')).toBe('screen cleared')
    expect(stripAnsi('\x1b[1;1Hhello')).toBe('hello')
  })
  it('removes SGR sequences with multiple params', () => {
    expect(stripAnsi('\x1b[38;5;200mcolored\x1b[0m')).toBe('colored')
  })
  it('returns unchanged string when no escapes present', () => {
    const plain = 'Hello, world!\nSecond line\twith tab.'
    expect(stripAnsi(plain)).toBe(plain)
  })
})
