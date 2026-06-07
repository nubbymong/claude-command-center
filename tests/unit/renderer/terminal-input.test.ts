import { describe, it, expect } from 'vitest'
import { isControlReportOnly, decideContextMenuAction } from '../../../src/renderer/utils/terminalInput'

describe('isControlReportOnly', () => {
  it('treats focus in/out reports as control-only (not input)', () => {
    expect(isControlReportOnly('\x1b[I')).toBe(true)
    expect(isControlReportOnly('\x1b[O')).toBe(true)
  })
  it('treats cursor-position reports as control-only', () => {
    expect(isControlReportOnly('\x1b[12;40R')).toBe(true)
  })
  it('treats SGR mouse reports as control-only', () => {
    expect(isControlReportOnly('\x1b[<0;10;20M')).toBe(true)
    expect(isControlReportOnly('\x1b[<0;10;20m')).toBe(true)
  })
  it('treats genuine typed characters as input', () => {
    expect(isControlReportOnly('a')).toBe(false)
    expect(isControlReportOnly('\r')).toBe(false)
    expect(isControlReportOnly('ls -la')).toBe(false)
  })
  it('treats a control report followed by typed input as input', () => {
    expect(isControlReportOnly('\x1b[Ohello')).toBe(false)
  })
  it('empty string is not input', () => {
    expect(isControlReportOnly('')).toBe(true)
  })
})

describe('decideContextMenuAction', () => {
  // Right-click must ALWAYS paste, never copy.
  // CC's copy-on-select already copies selected text on mouse-up;
  // re-copying on right-click would clobber the intended paste target.
  it('returns paste when there is no selection', () => {
    expect(decideContextMenuAction(false)).toBe('paste')
  })
  it('returns paste even when text is selected', () => {
    expect(decideContextMenuAction(true)).toBe('paste')
  })
})
