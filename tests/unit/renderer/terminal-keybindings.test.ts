// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { installTerminalKeybindings } from '../../../src/renderer/components/terminal/terminalKeybindings'

// #154. The #145 bug was a keydown handler registered on `document` in the BUBBLE
// phase: xterm's own listener lives on the helper textarea and fires in the TARGET
// phase, so it had already converted Ctrl+V to the raw control byte \x16 and written
// it to the PTY before the handler ran. It typechecked and passed every predicate
// test while being dead code on the only path that mattered.
//
// These tests drive the REAL installer and use a listener on the textarea as a
// stand-in for xterm. "xterm never sees the chord" is the assertion that would have
// failed before the fix, and it fails again if anyone drops the capture flag.

const chord = (init: Partial<KeyboardEventInit> & { key: string }) =>
  new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })

function harness(over: Record<string, unknown> = {}) {
  // A real textarea carrying xterm's marker class, so isOrdinaryEditable treats it
  // as "the terminal" rather than an ordinary input.
  const textarea = document.createElement('textarea')
  textarea.className = 'xterm-helper-textarea'
  document.body.appendChild(textarea)

  // Stands in for xterm's own keydown handler.
  const xtermSaw: string[] = []
  textarea.addEventListener('keydown', (e) => { xtermSaw.push((e as KeyboardEvent).key) })

  const term = {
    getSelection: vi.fn(() => ''),
    paste: vi.fn(),
    clearSelection: vi.fn(),
  }
  const readText = vi.fn(async () => 'CLIP')
  const writeText = vi.fn(async () => {})
  const onNothingToPaste = vi.fn()

  const dispose = installTerminalKeybindings({
    term,
    isActive: () => true,
    readText,
    writeText,
    onNothingToPaste,
    hasModalOpen: () => false,
    getActiveElement: () => textarea,
    ...over,
  } as Parameters<typeof installTerminalKeybindings>[0])

  return { textarea, xtermSaw, term, readText, writeText, onNothingToPaste, dispose }
}

beforeEach(() => { document.body.innerHTML = '' })

describe('installTerminalKeybindings — event-phase ordering (the #145 regression)', () => {
  it('xterm NEVER sees a paste chord', async () => {
    // THE test. Pre-fix this failed: xterm saw 'v', emitted \x16, and nothing pasted.
    const h = harness()
    h.textarea.dispatchEvent(chord({ key: 'v', ctrlKey: true }))
    await Promise.resolve()
    await Promise.resolve()

    expect(h.xtermSaw).toEqual([])
    expect(h.term.paste).toHaveBeenCalledWith('CLIP')
    h.dispose()
  })

  it('xterm NEVER sees a copy chord', async () => {
    const h = harness({ term: { getSelection: () => 'picked', paste: vi.fn(), clearSelection: vi.fn() } })
    h.textarea.dispatchEvent(chord({ key: 'C', ctrlKey: true, shiftKey: true }))
    await Promise.resolve()

    expect(h.xtermSaw).toEqual([])
    h.dispose()
  })

  it('lets every other keystroke through to xterm untouched', async () => {
    // Guard against over-reach: intercepting ordinary typing would break the terminal.
    const h = harness()
    h.textarea.dispatchEvent(chord({ key: 'a' }))
    h.textarea.dispatchEvent(chord({ key: 'c', ctrlKey: true }))   // Ctrl+C = SIGINT
    h.textarea.dispatchEvent(chord({ key: 'Enter' }))
    await Promise.resolve()

    expect(h.xtermSaw).toEqual(['a', 'c', 'Enter'])
    expect(h.term.paste).not.toHaveBeenCalled()
    h.dispose()
  })

  it('marks the paste chord handled so the native command cannot double-act', () => {
    const h = harness()
    const e = chord({ key: 'v', ctrlKey: true })
    h.textarea.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    h.dispose()
  })
})

describe('installTerminalKeybindings — disposal', () => {
  it('stops intercepting after dispose, and xterm gets the chord back', async () => {
    // A capture-flag mismatch on removeEventListener silently removes nothing,
    // leaking a listener that keeps pasting into a disposed terminal.
    const h = harness()
    h.dispose()

    h.textarea.dispatchEvent(chord({ key: 'v', ctrlKey: true }))
    await Promise.resolve()
    await Promise.resolve()

    expect(h.term.paste).not.toHaveBeenCalled()
    expect(h.xtermSaw).toEqual(['v'])
  })
})

describe('installTerminalKeybindings — guards', () => {
  it('does nothing for an INACTIVE terminal', async () => {
    // Every session's TerminalView stays mounted and shares this document listener,
    // so without this one Ctrl+V would paste into every open session at once.
    const h = harness({ isActive: () => false })
    h.textarea.dispatchEvent(chord({ key: 'v', ctrlKey: true }))
    await Promise.resolve()
    await Promise.resolve()

    expect(h.term.paste).not.toHaveBeenCalled()
    expect(h.xtermSaw).toEqual(['v']) // not ours to claim — left alone entirely
    h.dispose()
  })

  it('reads isActive fresh on every keystroke, not once at install', async () => {
    // The stale-capture trap: the installing effect keys on session identity, so a
    // captured boolean would never see a tab switch.
    let active = false
    const h = harness({ isActive: () => active })

    h.textarea.dispatchEvent(chord({ key: 'v', ctrlKey: true }))
    await Promise.resolve(); await Promise.resolve()
    expect(h.term.paste).not.toHaveBeenCalled()

    active = true
    h.textarea.dispatchEvent(chord({ key: 'v', ctrlKey: true }))
    await Promise.resolve(); await Promise.resolve()
    expect(h.term.paste).toHaveBeenCalledWith('CLIP')
    h.dispose()
  })

  it('defers while a modal is open', async () => {
    const h = harness({ hasModalOpen: () => true })
    h.textarea.dispatchEvent(chord({ key: 'v', ctrlKey: true }))
    await Promise.resolve(); await Promise.resolve()
    expect(h.term.paste).not.toHaveBeenCalled()
    h.dispose()
  })

  it('defers to the native paste when focus is in an ordinary input', async () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    const h = harness({ getActiveElement: () => input })

    h.textarea.dispatchEvent(chord({ key: 'v', ctrlKey: true }))
    await Promise.resolve(); await Promise.resolve()

    expect(h.term.paste).not.toHaveBeenCalled()
    h.dispose()
  })

  it('still handles the chord when focus is on xterm own helper textarea', async () => {
    // That textarea IS the terminal, so it must not count as an ordinary editable.
    const h = harness()
    h.textarea.dispatchEvent(chord({ key: 'v', ctrlKey: true }))
    await Promise.resolve(); await Promise.resolve()
    expect(h.term.paste).toHaveBeenCalledWith('CLIP')
    h.dispose()
  })
})

describe('installTerminalKeybindings — paste behaviour', () => {
  it('reports rather than silently doing nothing when the clipboard is empty', async () => {
    const h = harness({ readText: async () => '' })
    h.textarea.dispatchEvent(chord({ key: 'v', ctrlKey: true }))
    await Promise.resolve(); await Promise.resolve()

    expect(h.term.paste).not.toHaveBeenCalled()
    expect(h.onNothingToPaste).toHaveBeenCalled()
    h.dispose()
  })

  it('treats a rejected clipboard read as nothing to paste, without throwing', async () => {
    const h = harness({ readText: async () => { throw new Error('denied') } })
    h.textarea.dispatchEvent(chord({ key: 'v', ctrlKey: true }))
    await Promise.resolve(); await Promise.resolve()

    expect(h.term.paste).not.toHaveBeenCalled()
    expect(h.onNothingToPaste).toHaveBeenCalled()
    h.dispose()
  })

  it('accepts Shift+Insert and Cmd+V as well', async () => {
    const h = harness()
    h.textarea.dispatchEvent(chord({ key: 'Insert', shiftKey: true }))
    await Promise.resolve(); await Promise.resolve()
    expect(h.term.paste).toHaveBeenCalledTimes(1)

    h.textarea.dispatchEvent(chord({ key: 'v', metaKey: true }))
    await Promise.resolve(); await Promise.resolve()
    expect(h.term.paste).toHaveBeenCalledTimes(2)
    h.dispose()
  })

  it('handles an INJECTED chord that carries no code field', async () => {
    // Measured from real dictation input (#145): synthesized keystrokes have no
    // physical scan code, so `code` is absent. Requiring it would exclude them.
    const h = harness()
    h.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true }))
    await Promise.resolve(); await Promise.resolve()
    expect(h.term.paste).toHaveBeenCalledWith('CLIP')
    h.dispose()
  })
})

describe('installTerminalKeybindings — copy behaviour', () => {
  it('copies the selection and clears it', async () => {
    const term = { getSelection: () => 'picked', paste: vi.fn(), clearSelection: vi.fn() }
    const h = harness({ term })
    h.textarea.dispatchEvent(chord({ key: 'C', ctrlKey: true, shiftKey: true }))
    await Promise.resolve(); await Promise.resolve()

    expect(h.writeText).toHaveBeenCalledWith('picked')
    expect(term.clearSelection).toHaveBeenCalled()
    h.dispose()
  })

  it('does nothing when there is no selection', async () => {
    const h = harness()
    h.textarea.dispatchEvent(chord({ key: 'C', ctrlKey: true, shiftKey: true }))
    await Promise.resolve()
    expect(h.writeText).not.toHaveBeenCalled()
    h.dispose()
  })

  it('does NOT copy for an inactive terminal', async () => {
    // The #153 defect: the old copy handler had no isActive guard, so it ran once per
    // mounted terminal.
    const term = { getSelection: () => 'picked', paste: vi.fn(), clearSelection: vi.fn() }
    const h = harness({ term, isActive: () => false })
    h.textarea.dispatchEvent(chord({ key: 'C', ctrlKey: true, shiftKey: true }))
    await Promise.resolve()
    expect(h.writeText).not.toHaveBeenCalled()
    h.dispose()
  })

  it('copies under caps lock, where the key arrives lowercase', async () => {
    // The old check compared `e.key === 'C'` exactly, so copy silently stopped
    // working with caps lock on.
    const term = { getSelection: () => 'picked', paste: vi.fn(), clearSelection: vi.fn() }
    const h = harness({ term })
    h.textarea.dispatchEvent(chord({ key: 'c', ctrlKey: true, shiftKey: true }))
    await Promise.resolve(); await Promise.resolve()
    expect(h.writeText).toHaveBeenCalledWith('picked')
    h.dispose()
  })

  it('survives a rejected clipboard write without clearing the selection', async () => {
    const term = { getSelection: () => 'picked', paste: vi.fn(), clearSelection: vi.fn() }
    const h = harness({ term, writeText: async () => { throw new Error('denied') } })
    h.textarea.dispatchEvent(chord({ key: 'C', ctrlKey: true, shiftKey: true }))
    await Promise.resolve(); await Promise.resolve()
    expect(term.clearSelection).not.toHaveBeenCalled()
    h.dispose()
  })
})
