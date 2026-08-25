// @vitest-environment jsdom
//
// #478: submitting a review auto-returns the user to the terminal after a
// short confirmation beat. If the user also clicks a pane toggle inside that
// window, the two pushes raced — a toggle-based landing REOPENED the pane the
// user had just closed (double flip / flicker). The rule now: while the
// submit hand-back is in flight it is the ONLY driver of pane state — the
// landing lives in the store, CLOSES rather than toggles, and the pane
// toggles disable for the beat.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import AgentCanvasButton from '../../../src/renderer/components/AgentCanvasButton'
import { useExcalidrawStore, SUBMIT_RETURN_DELAY_MS } from '../../../src/renderer/stores/excalidrawStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const SID = 'session-race'

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    onChanged: () => () => {},
    getState: vi.fn().mockResolvedValue(null),
    reviewGetState: vi.fn().mockResolvedValue(null),
    listAll: vi.fn().mockResolvedValue([]),
  },
}

beforeEach(() => {
  vi.useFakeTimers()
  useExcalidrawStore.getState().cancelSubmitReturn(SID)
  useExcalidrawStore.getState().setOpen(SID, false)
})

afterEach(() => {
  vi.useRealTimers()
})

const flag = () => !!useExcalidrawStore.getState().submitReturnBySession[SID]
const open = () => !!useExcalidrawStore.getState().bySessionId[SID]?.isOpen

describe('the store-owned submit hand-back', () => {
  it('flags the session, then lands by closing the pane and clearing the flag', () => {
    useExcalidrawStore.getState().setOpen(SID, true)
    useExcalidrawStore.getState().beginSubmitReturn(SID)
    expect(flag()).toBe(true)
    expect(open()).toBe(true)

    vi.advanceTimersByTime(SUBMIT_RETURN_DELAY_MS)
    expect(open()).toBe(false)
    expect(flag()).toBe(false)
  })

  it('THE RACE: a pane closed inside the window is not reopened by the landing', () => {
    // The old shape: the landing called togglePane, so a user click that had
    // already closed the pane got it flipped back open.
    useExcalidrawStore.getState().setOpen(SID, true)
    useExcalidrawStore.getState().beginSubmitReturn(SID)
    useExcalidrawStore.getState().togglePane(SID) // the user's racing close
    expect(open()).toBe(false)

    vi.advanceTimersByTime(SUBMIT_RETURN_DELAY_MS)
    expect(open()).toBe(false) // stays closed — no double flip
    expect(flag()).toBe(false)
  })

  it('cancel clears the flag and the landing never fires', () => {
    useExcalidrawStore.getState().setOpen(SID, true)
    useExcalidrawStore.getState().beginSubmitReturn(SID)
    useExcalidrawStore.getState().cancelSubmitReturn(SID)
    expect(flag()).toBe(false)

    vi.advanceTimersByTime(SUBMIT_RETURN_DELAY_MS * 2)
    // The early-leaver navigated themselves; the store must not close (or
    // reopen) anything afterwards.
    expect(open()).toBe(true)
  })

  it('re-arming replaces the pending landing instead of stacking two', () => {
    useExcalidrawStore.getState().setOpen(SID, true)
    useExcalidrawStore.getState().beginSubmitReturn(SID)
    vi.advanceTimersByTime(SUBMIT_RETURN_DELAY_MS - 100)
    useExcalidrawStore.getState().beginSubmitReturn(SID)

    // The first deadline passes — replaced, so nothing lands yet.
    vi.advanceTimersByTime(100)
    expect(open()).toBe(true)
    expect(flag()).toBe(true)

    vi.advanceTimersByTime(SUBMIT_RETURN_DELAY_MS)
    expect(open()).toBe(false)
    expect(flag()).toBe(false)
  })

  it('reset cancels an in-flight hand-back with the session', () => {
    useExcalidrawStore.getState().setOpen(SID, true)
    useExcalidrawStore.getState().beginSubmitReturn(SID)
    useExcalidrawStore.getState().reset(SID)
    expect(flag()).toBe(false)
    vi.advanceTimersByTime(SUBMIT_RETURN_DELAY_MS * 2)
    // The session state is gone; the landing must not resurrect it.
    expect(useExcalidrawStore.getState().bySessionId[SID]).toBeUndefined()
  })
})

describe('the pane toggles disable while the hand-back is in flight', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('the command-bar Canvas button is disabled for the beat, then usable again', () => {
    useExcalidrawStore.getState().setOpen(SID, true)
    act(() => { root.render(<AgentCanvasButton sessionId={SID} />) })
    const btn = container.querySelector('[data-testid="canvas-button"]') as HTMLButtonElement
    expect(btn.disabled).toBe(false)

    act(() => { useExcalidrawStore.getState().beginSubmitReturn(SID) })
    expect(btn.disabled).toBe(true)
    expect(btn.title).toBe('Returning to the terminal…')

    act(() => { vi.advanceTimersByTime(SUBMIT_RETURN_DELAY_MS) })
    expect(btn.disabled).toBe(false)
    // Landed: the pane is closed and the toggle reads as the way back in.
    expect(open()).toBe(false)
  })

  it('the pane close control and the panel wiring carry the contract (source pin)', () => {
    // Mounting CanvasSurface / the full submit flow is out of proportion here;
    // pin the wiring the way the shortcut suite pins data-shortcut-capture.
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const pane = fs.readFileSync(path.resolve(__dirname, '../../../src/renderer/components/AgentCanvasPane.tsx'), 'utf8')
    expect(pane).toMatch(/disabled=\{returning\}\s*\n\s*aria-label="Close Agent Canvas"/)
    const panel = fs.readFileSync(path.resolve(__dirname, '../../../src/renderer/components/CanvasNotesPanel.tsx'), 'utf8')
    expect(panel).toContain('beginSubmitReturn(sessionId)')
    expect(panel).toContain('cancelSubmitReturn(sessionId)')
  })
})
