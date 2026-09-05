// @vitest-environment jsdom
//
// The session area shows ONE surface at a time — terminal, browser, canvas or
// logs (owner, 2026-09-05). Opening any alt-pane must close the others; the
// bug this fixes was the canvas not rendering when opened over the browser,
// because the three panes were independent flags and a fixed priority kept the
// browser winning. These drive the REAL coordinator against the REAL stores.
import { describe, it, expect, beforeEach } from 'vitest'
import { toggleAltPane, closeOtherAltPanes, type AltPaneKind } from '../../../src/renderer/stores/altPane'
import { useExcalidrawStore } from '../../../src/renderer/stores/excalidrawStore'
import { useWebviewStore } from '../../../src/renderer/stores/webviewStore'
import { useLogsStore } from '../../../src/renderer/stores/useLogsStore'

const SID = 'sess-1'
const openState = (sid = SID) => ({
  canvas: !!useExcalidrawStore.getState().bySessionId[sid]?.isOpen,
  browser: !!useWebviewStore.getState().bySessionId[sid]?.isOpen,
  logs: !!useLogsStore.getState().bySessionId[sid]?.isOpen,
})
const openCount = (sid = SID) => Object.values(openState(sid)).filter(Boolean).length

beforeEach(() => {
  useExcalidrawStore.getState().setOpen(SID, false)
  useWebviewStore.getState().setOpen(SID, false)
  useLogsStore.getState().setOpen(SID, false)
})

describe('alt-pane coordinator — one session surface at a time', () => {
  it('opening a surface from the terminal opens exactly it', () => {
    toggleAltPane(SID, 'canvas')
    expect(openState()).toEqual({ canvas: true, browser: false, logs: false })
  })

  it('REGRESSION: opening the canvas while the browser is open closes the browser', () => {
    toggleAltPane(SID, 'browser')
    expect(openState()).toEqual({ canvas: false, browser: true, logs: false })
    toggleAltPane(SID, 'canvas')
    expect(openState()).toEqual({ canvas: true, browser: false, logs: false })
    expect(openCount()).toBe(1)
  })

  it('every ordered pair of surfaces switches cleanly, never two open', () => {
    const kinds: AltPaneKind[] = ['canvas', 'browser', 'logs']
    for (const a of kinds) for (const b of kinds) {
      if (a === b) continue
      useExcalidrawStore.getState().setOpen(SID, false)
      useWebviewStore.getState().setOpen(SID, false)
      useLogsStore.getState().setOpen(SID, false)
      toggleAltPane(SID, a)
      toggleAltPane(SID, b)
      expect(openCount(), `${a}->${b}`).toBe(1)
      expect(openState()[b], `${a}->${b} shows ${b}`).toBe(true)
    }
  })

  it('clicking the open surface again returns to the terminal (all closed)', () => {
    toggleAltPane(SID, 'logs')
    expect(openState().logs).toBe(true)
    toggleAltPane(SID, 'logs')
    expect(openCount()).toBe(0)
  })

  it('closeOtherAltPanes evicts the others but keeps the one named (the browser agent-push path)', () => {
    toggleAltPane(SID, 'canvas')
    // The browser's navigate() opens the browser itself; the push path then evicts the rest.
    useWebviewStore.getState().setOpen(SID, true)
    closeOtherAltPanes(SID, 'browser')
    expect(openState()).toEqual({ canvas: false, browser: true, logs: false })
  })

  it('is per session — one session\'s surface does not touch another\'s', () => {
    toggleAltPane('sess-A', 'canvas')
    toggleAltPane('sess-B', 'browser')
    expect(openState('sess-A')).toEqual({ canvas: true, browser: false, logs: false })
    expect(openState('sess-B')).toEqual({ canvas: false, browser: true, logs: false })
    useExcalidrawStore.getState().setOpen('sess-A', false)
    useWebviewStore.getState().setOpen('sess-B', false)
  })
})
