/**
 * The main window's saved geometry.
 *
 * Lifted out of `index.ts` by #371. It lived there as two private functions
 * whose failure handling was a bare `catch { /* ignore *\/ }` returning the
 * hardcoded default — so an unreadable window-state.json silently resized the
 * user's window to 3200x1800, and the close handler wrote that default straight
 * back over their real geometry. It is also the only one of the five persisters
 * that bypassed `config-manager` entirely, so it never had the atomic write.
 *
 * Both are fixed by going through the shared `windowState` config key, which
 * resolves to exactly the path this used to build by hand
 * (`<CONFIG>/window-state.json`) — so there is no migration — plus the shared
 * read-failure latch (see `persist-latch.ts`).
 */

import { createReadFailureLatch, loadConfigLatched, saveConfigLatched } from './persist-latch'

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  isMaximized: boolean
}

export const DEFAULT_WINDOW_STATE: WindowState = { width: 3200, height: 1800, isMaximized: false }

const windowStateLatch = createReadFailureLatch('window-state')

/**
 * The saved geometry, or the default.
 *
 * A window has to open at SOME size, so a read failure still returns the
 * default here — what changes is that the latch remembers it was a failure, so
 * `saveWindowState` will not write that default back over the real file.
 */
export function loadWindowState(): WindowState {
  const saved = loadConfigLatched<WindowState>('windowState', windowStateLatch)
  if (!saved || typeof saved !== 'object') return { ...DEFAULT_WINDOW_STATE }
  // width/height are the only fields the window cannot open without; a
  // hand-edited or truncated file that lost them is not usable geometry.
  if (typeof saved.width !== 'number' || typeof saved.height !== 'number') return { ...DEFAULT_WINDOW_STATE }
  return saved
}

/**
 * Persist the geometry. Refused while the last load was a read FAILURE.
 *
 * Deliberately the ONE latched save with no recovery retry (#371). The others
 * retry because they load once at boot and save many times, so a refusal that
 * never lifts would be a session-long outage. This one loads once and saves
 * once, at window close, and the geometry it would write after a failed load is
 * the fallback DEFAULT rather than anything the user chose — so recovering the
 * file only to overwrite it with 3200x1800 would be the loss, not the fix.
 * Keeping the saved geometry is the right answer here, and the process is
 * ending anyway.
 */
export function saveWindowState(state: WindowState): boolean {
  // `retry: false` is what makes the paragraph above TRUE (#371, ADR-009 pass).
  // Without it the shared retry would recover the file and then write the
  // fallback 3200x1800 straight over the geometry it had just rescued — the
  // exact loss this refusal exists to prevent, with the doc claiming otherwise.
  return saveConfigLatched('windowState', state, windowStateLatch, { retry: false })
}

/** True while the last load failed to READ the file (rather than not find it). */
export function windowStateReadFailed(): boolean {
  return windowStateLatch.failed()
}

/** Test seam — the latch is module state and outlives a test file otherwise. */
export function _resetWindowStateLatchForTest(): void {
  windowStateLatch.reset()
}

export function clampToVisibleDisplay(state: WindowState): WindowState {
  const { screen } = require('electron')
  const displays = screen.getAllDisplays()
  const primaryWorkArea = screen.getPrimaryDisplay().workArea

  // Clamp size to primary display work area
  const width = Math.min(state.width, primaryWorkArea.width)
  const height = Math.min(state.height, primaryWorkArea.height)

  // If no position saved, center on primary display
  if (state.x === undefined || state.y === undefined) {
    return {
      ...state,
      width,
      height,
      x: primaryWorkArea.x + Math.round((primaryWorkArea.width - width) / 2),
      y: primaryWorkArea.y + Math.round((primaryWorkArea.height - height) / 2),
    }
  }

  // Check if saved position is visible on any display
  const isVisible = displays.some((display: Electron.Display) => {
    const wa = display.workArea
    return (
      state.x! >= wa.x - 100 &&
      state.y! >= wa.y - 100 &&
      state.x! < wa.x + wa.width - 50 &&
      state.y! < wa.y + wa.height - 50
    )
  })

  if (isVisible) {
    return { ...state, width, height }
  }

  // Off-screen: center on primary display
  return {
    ...state,
    width,
    height,
    x: primaryWorkArea.x + Math.round((primaryWorkArea.width - width) / 2),
    y: primaryWorkArea.y + Math.round((primaryWorkArea.height - height) / 2),
  }
}

export function saveWindowStateFor(win: import('electron').BrowserWindow): void {
  const bounds = win.getBounds()
  saveWindowState({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: win.isMaximized()
  })
}
