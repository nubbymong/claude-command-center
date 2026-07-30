import { describe, it, expect } from 'vitest'
import { formatDiagEvent, describeNode } from '../../../src/renderer/utils/inputDiagnostics'

// #145: after two fixes built on assumed injection mechanisms, these lines are the
// evidence that replaces the guessing. They must stay greppable and lossless about
// the fields that discriminate one mechanism from another.
describe('formatDiagEvent', () => {
  it('renders a keystroke with the fields that identify the mechanism', () => {
    const line = formatDiagEvent({
      kind: 'keydown',
      key: 'v',
      code: 'KeyV',
      mods: 'ctrl',
      isTrusted: true,
      target: 'textarea.xterm-helper-textarea',
    })
    expect(line).toBe('keydown key="v" code=KeyV mods=ctrl trusted=true target=textarea.xterm-helper-textarea')
  })

  it('quotes key and data so whitespace and empty strings stay visible', () => {
    // A synthesized space or an empty-string data payload is meaningful signal;
    // unquoted it would be invisible in the log.
    expect(formatDiagEvent({ kind: 'keydown', key: ' ' })).toContain('key=" "')
    expect(formatDiagEvent({ kind: 'input', data: '' })).toContain('data=""')
  })

  it('omits absent fields rather than printing undefined', () => {
    expect(formatDiagEvent({ kind: 'window:focus' })).toBe('window:focus')
  })

  it('keeps trusted=false, which is how injected input betrays itself', () => {
    expect(formatDiagEvent({ kind: 'keydown', key: 'a', isTrusted: false })).toContain('trusted=false')
  })

  it('renders a zero valueLen (distinct from absent)', () => {
    // valueLen=0 means "the event fired but carried nothing" — a different
    // diagnosis from the field being missing entirely.
    expect(formatDiagEvent({ kind: 'paste', valueLen: 0 })).toContain('valueLen=0')
  })

  it('includes the note used to flag a programmatic value set', () => {
    const line = formatDiagEvent({ kind: 'poll:textareaValue', valueLen: 5, note: 'programmatic set' })
    expect(line).toContain('note=programmatic set')
  })
})

describe('describeNode', () => {
  const el = (tagName: string, className = '') => ({ tagName, className }) as unknown as EventTarget

  it('renders tag plus dotted classes', () => {
    expect(describeNode(el('TEXTAREA', 'xterm-helper-textarea'))).toBe('textarea.xterm-helper-textarea')
    expect(describeNode(el('DIV', 'a b'))).toBe('div.a.b')
  })

  it('renders a bare tag when there is no class', () => {
    expect(describeNode(el('BODY'))).toBe('body')
  })

  it('handles null and non-element targets without throwing', () => {
    expect(describeNode(null)).toBe('null')
    // window/document targets have no tagName.
    expect(describeNode({} as EventTarget)).toBe('Object')
  })

  it('tolerates a non-string className (SVG animated class)', () => {
    const svgish = { tagName: 'svg', className: { baseVal: 'x' } } as unknown as EventTarget
    expect(describeNode(svgish)).toBe('svg')
  })
})
