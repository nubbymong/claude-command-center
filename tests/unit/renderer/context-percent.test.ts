// P3.8 round 3 (CM): the terminal's context reading. Codex's footer says how
// much context is LEFT ("100% context left", the P3.8 VM capture of 0.155.1);
// the meter shows how much is used, so a figure followed by "left" or
// "remaining" is read as the share left. The other shapes read as before.
import { describe, it, expect } from 'vitest'
import { readContextPercent, stripTerminalControls } from '../../../src/renderer/components/terminal/contextPercent'

const ESC = String.fromCharCode(0x1b)

describe('the context reading from terminal output', () => {
  it("reads Codex's own \"N% context left\" as the share left (the VM capture)", () => {
    // The raw bytes as the VM recorded them, dim text and a cursor move included.
    const raw = `${ESC}[2mtab to queue message${ESC}[22m${ESC}[145X${ESC}[2m${ESC}[145C100% context left${ESC}[22m  `
    expect(readContextPercent(stripTerminalControls(raw))).toEqual({ used: 0 })
    expect(readContextPercent('  37% context left')).toEqual({ used: 63 })
    expect(readContextPercent('12.5% remaining')).toEqual({ used: 87.5 })
  })

  it('reads the used shapes as before', () => {
    expect(readContextPercent('45% context')).toEqual({ used: 45 })
    expect(readContextPercent('80% used')).toEqual({ used: 80 })
    expect(readContextPercent('context: 12%')).toEqual({ used: 12 })
    expect(readContextPercent('23% | $0.12')).toEqual({ used: 23 })
    expect(readContextPercent('9% ctx')).toEqual({ used: 9 })
  })

  it('a figure out of range is a match with no reading; no figure is no match', () => {
    expect(readContextPercent('140% context')).toEqual({ used: null })
    expect(readContextPercent('nothing to see here')).toBeNull()
  })
})
