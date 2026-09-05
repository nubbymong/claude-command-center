/**
 * Alt-pane coordination — the session area shows ONE surface at a time:
 * the terminal, the browser, the Agent Canvas, or the Logs pane. They are
 * mutually exclusive (owner, 2026-09-05: "you are in terminal or canvas or
 * browser — switch between them").
 *
 * Before this, the three panes were independent `isOpen` flags and App.tsx
 * rendered the highest-priority open one (Logs > Browser > Canvas). Opening the
 * canvas while the browser was open left the browser flag set, so the browser
 * kept winning the priority and the canvas never rendered — the "canvas doesn't
 * open on top" bug. Routing every surface toggle through here keeps at most one
 * flag set, so the priority never has a conflict AND the browser's native
 * WebContentsView detaches the instant another surface opens (no HTML canvas
 * can sit over a native view, so closing the browser is what reveals the
 * canvas).
 *
 * Closing a surface (its button clicked while open, or its own Close control)
 * returns to the terminal and needs no coordination — only OPENING must evict
 * the others, which is what `toggleAltPane` / `closeOtherAltPanes` do.
 */
import { useExcalidrawStore } from './excalidrawStore'
import { useWebviewStore } from './webviewStore'
import { useLogsStore } from './useLogsStore'

export type AltPaneKind = 'canvas' | 'browser' | 'logs'

const ALL: readonly AltPaneKind[] = ['canvas', 'browser', 'logs']

function isPaneOpen(kind: AltPaneKind, sessionId: string): boolean {
  if (kind === 'canvas') return !!useExcalidrawStore.getState().bySessionId[sessionId]?.isOpen
  if (kind === 'browser') return !!useWebviewStore.getState().bySessionId[sessionId]?.isOpen
  return !!useLogsStore.getState().bySessionId[sessionId]?.isOpen
}

function setPaneOpen(kind: AltPaneKind, sessionId: string, open: boolean): void {
  if (kind === 'canvas') useExcalidrawStore.getState().setOpen(sessionId, open)
  else if (kind === 'browser') useWebviewStore.getState().setOpen(sessionId, open)
  else useLogsStore.getState().setOpen(sessionId, open)
}

/**
 * Close every alt-pane for this session EXCEPT `keep`. The browser store calls
 * it from its own `navigate` and `openAccountPane` — the writes that open the
 * pane by a path other than its toggle button (an agent push, a "page" command,
 * the Artifacts button, Settings' sign-in) — so the one-surface rule is
 * enforced at the source rather than remembered per caller.
 */
export function closeOtherAltPanes(sessionId: string, keep: AltPaneKind): void {
  for (const k of ALL) {
    if (k !== keep && isPaneOpen(k, sessionId)) setPaneOpen(k, sessionId, false)
  }
}

/**
 * Open `kind` and close the other two, whatever the current state (NOT a
 * toggle). For paths that open a surface unconditionally — a canvas resumed
 * from the queue, a "page" command that opens the browser — so the
 * one-surface rule holds there as it does for the toggle buttons.
 */
export function openAltPane(sessionId: string, kind: AltPaneKind): void {
  closeOtherAltPanes(sessionId, kind)
  setPaneOpen(kind, sessionId, true)
}

/**
 * The toggle a surface button fires: if that surface is already open, close it
 * (back to the terminal); otherwise open it and close the other two. Keyed per
 * session — each session carries its own open surface.
 */
export function toggleAltPane(sessionId: string, kind: AltPaneKind): void {
  if (isPaneOpen(kind, sessionId)) {
    setPaneOpen(kind, sessionId, false)
    return
  }
  closeOtherAltPanes(sessionId, kind)
  setPaneOpen(kind, sessionId, true)
}
