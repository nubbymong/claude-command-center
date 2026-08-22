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

/** Persist the geometry. Refused while the last load was a read FAILURE. */
export function saveWindowState(state: WindowState): boolean {
  return saveConfigLatched('windowState', state, windowStateLatch)
}

/** True while the last load failed to READ the file (rather than not find it). */
export function windowStateReadFailed(): boolean {
  return windowStateLatch.failed()
}

/** Test seam — the latch is module state and outlives a test file otherwise. */
export function _resetWindowStateLatchForTest(): void {
  windowStateLatch.reset()
}
