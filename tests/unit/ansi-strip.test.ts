// Direct unit coverage of stripAnsiForSentinel (src/main/ansi-strip.ts). The
// parser-level tests (pty-manager-ssh-tmux, ssh-tmux-push) exercise it through
// the four SSH sentinel parsers with OSC+CSI glue; this file covers the strip
// itself — every escape class, the two escape families the parser fixtures do
// NOT reach (DCS/APC/PM and the nF/Fe two-byte forms), the deliberate
// \r\n-abort deviation from ui-detection's OSC class, and the linearity that
// keeps it off the ReDoS list. Added 2026-08-27 after an adversarial review
// found the module had no direct test and its charset-designation / two-byte
// families were unstripped (the incident recurs through a host's own tmux,
// which emits `\x1b(B` after SGR resets).
import { describe, it, expect } from 'vitest'
import { stripAnsiForSentinel } from '../../src/main/ansi-strip'

const SENTINEL = 'ccc-tmux-stage abc123 ok path=/home/pi/.claude/bin/tmux'

describe('stripAnsiForSentinel', () => {
  it('removes a CSI sequence, including private-mode params', () => {
    expect(stripAnsiForSentinel('a\x1b[0mb\x1b[?25lc')).toBe('abc')
    expect(stripAnsiForSentinel('a\x1b[38;2;1;2;3mb')).toBe('ab')
  })

  it('removes a complete OSC (BEL- and ST-terminated)', () => {
    expect(stripAnsiForSentinel('a\x1b]0;title\x07b')).toBe('ab')
    expect(stripAnsiForSentinel('a\x1b]0;title\x1b\\b')).toBe('ab')
  })

  it('removes DCS / APC / PM / SOS strings (no parser fixture reaches these)', () => {
    expect(stripAnsiForSentinel('a\x1bP1;2|body\x1b\\b')).toBe('ab') // DCS
    expect(stripAnsiForSentinel('a\x1b_appcmd\x07b')).toBe('ab')      // APC
    expect(stripAnsiForSentinel('a\x1b^privmsg\x07b')).toBe('ab')     // PM
    expect(stripAnsiForSentinel('a\x1bXsos\x1b\\b')).toBe('ab')       // SOS
  })

  it('removes nF charset-designation escapes (the incident family via a host tmux)', () => {
    expect(stripAnsiForSentinel('a\x1b(Bb')).toBe('ab')  // designate ASCII
    expect(stripAnsiForSentinel('a\x1b(0b')).toBe('ab')  // designate line-drawing
    expect(stripAnsiForSentinel('a\x1b)0b')).toBe('ab')
    expect(stripAnsiForSentinel('a\x1b#8b')).toBe('ab')  // DEC alignment
  })

  it('removes two-byte Fe/Fp/Fs escapes (cursor save/restore bracket a repaint)', () => {
    expect(stripAnsiForSentinel('a\x1b7b\x1b8c')).toBe('abc') // save / restore
    expect(stripAnsiForSentinel('a\x1bMb\x1bDc\x1bEd')).toBe('abcd')
    expect(stripAnsiForSentinel('a\x1bcb')).toBe('ab')        // full reset
    expect(stripAnsiForSentinel('a\x1b=b\x1b>c')).toBe('abc') // keypad modes
  })

  it('does NOT let the two-byte class eat a multi-byte introducer byte', () => {
    // `[` `]` `P` `X` `^` `_` must remain owned by the long-form classes; an
    // incomplete introducer is left for TRAILING_PARTIAL only when it is at the
    // end, never swallowed as a two-byte escape mid-string.
    expect(stripAnsiForSentinel('a\x1b[1mb')).toBe('ab')
    expect(stripAnsiForSentinel('a\x1b]0;t\x07b')).toBe('ab')
  })

  it('strips every family glued before a sentinel line terminator (the fix)', () => {
    const glued = `${SENTINEL}\x1b(B\x1b[?25h\x1b]0;C:/x\x07\x1b7\r\n`
    expect(stripAnsiForSentinel(glued)).toBe(`${SENTINEL}\r\n`)
  })

  it('preserves the line terminator (never invents or deletes \\r or \\n)', () => {
    // Delete-only: the count of \r and \n is invariant under the strip. This is
    // what keeps the parsers' (?=[\r\n]) chunk-boundary discipline honest.
    for (const s of [`${SENTINEL}\x1b[0m\r\n`, 'x\ny\rz', `${SENTINEL}\x1b7`]) {
      const before = (s.match(/[\r\n]/g) ?? []).length
      const after = (stripAnsiForSentinel(s).match(/[\r\n]/g) ?? []).length
      expect(after).toBe(before)
    }
  })

  it('drops only a TRAILING unterminated escape, and never past a newline', () => {
    // A partial escape at the very end is unfinished output — dropped.
    expect(stripAnsiForSentinel(`${SENTINEL}\x1b]0;C:/WINDOWS/Sys`)).toBe(SENTINEL)
    // A mid-buffer INCOMPLETE escape (no final byte, before the terminator) is
    // left in place — it is neither a complete sequence nor trailing — but it
    // must not touch the complete sentinel LINE that follows. What matters for
    // the parsers is that the sentinel + its terminators are untouched.
    expect(stripAnsiForSentinel(`junk\x1b[\r\n${SENTINEL}\r\n`)).toContain(`\r\n${SENTINEL}\r\n`)
  })

  it('OSC body aborts on \\r/\\n (deviation from ui-detection): an unterminated OSC does not swallow a later sentinel', () => {
    // The load-bearing reason this module exists separately from
    // ui-detection.ts: on a multi-line accumulated buffer, an unterminated OSC
    // introducer earlier in the buffer plus ANY later BEL would, under a
    // \r\n-permissive OSC body, delete the sentinel line sitting between them.
    const buf = `\x1b]0;unterminated title\r\n${SENTINEL}\r\nnext\x07tail`
    expect(stripAnsiForSentinel(buf)).toContain(SENTINEL)
  })

  it('is linear on a flood of unterminated introducers (no ReDoS)', () => {
    // Bound generously; the real per-chunk input is capped at 4096 bytes
    // upstream (MAX_SETUP_LINE_BUFFER), so this is pure headroom. A quadratic
    // strip would blow well past this on 200KB.
    const flood = '\x1b]'.repeat(100_000) + '\x1b['.repeat(100_000)
    const t0 = performance.now()
    stripAnsiForSentinel(flood)
    expect(performance.now() - t0).toBeLessThan(500)
  })
})
